/**
 * 맥락 해석 워커.
 * 채널별로 최근 메시지를 조회 → 소울스트림 세션으로 해석 → 결과 저장.
 *
 * 해석 범위: targetWindow(기본 15, .env로 변경 가능) + priorWindow(기본 5) 메시지.
 *
 * 트리거:
 *   - 미해석 텍스트 ≥500토큰(text.length/4) → 즉시
 *   - 미해석 있으나 500토큰 미만 → 1분 간격
 * 채널별 동시 실행 방지: 인메모리 잠금.
 *
 * 노드 우선순위:
 *   - SOULSTREAM_PREFERRED_NODE_ID 설정 → 해당 노드로 세션 생성
 *   - rate limit 발생 → backoff 기간 동안 least-sessions 폴백, 이후 복귀
 */

import pg from "pg";
import type { Message, Interpretation, ContextInterpretation } from "../types/index.js";
import type { InterpretationService } from "../services/InterpretationService.js";
import type { EventBus } from "../shared/EventBus.js";
import { SoulstreamClient } from "./SoulstreamClient.js";
import {
  buildPrompt,
  toPromptMessage,
  estimateTokens,
  DEFAULT_INTERPRETATION_PROMPT,
} from "./buildPrompt.js";
import { parseResponse, detectChanges, ParseError } from "./parseResponse.js";
import type { MessageWithInterpretation } from "./buildPrompt.js";

const TOKEN_THRESHOLD = 500;
const IDLE_INTERVAL_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000; // 5분 backoff on rate limit

export interface InterpretationWorkerOpts {
  soulstreamBaseUrl: string;
  soulstreamAuthToken: string;
  soulstreamProfile?: string;
  soulstreamFolderId?: string;
  soulstreamPreferredNodeId?: string;
  pollIntervalMs?: number;
  idleIntervalMs?: number;
  targetWindow?: number;
  priorWindow?: number;
  soulstreamModel?: string;
}

export class InterpretationWorker {
  private running = false;
  private soulstream: SoulstreamClient;
  private pollIntervalMs: number;
  private idleIntervalMs: number;
  private targetWindow: number;
  private priorWindow: number;
  private preferredNodeId?: string;
  private rateLimitedUntil = 0;
  private channelLocks = new Set<string>();
  private promptCache: string | null = null;
  /** 채널별 마지막 해석 시각 — idle 간격 후 소량 배치도 처리하기 위해 사용 */
  private lastProcessed = new Map<string, number>();

  constructor(
    private pool: pg.Pool,
    private interpretationService: InterpretationService,
    private eventBus: EventBus,
    opts: InterpretationWorkerOpts,
  ) {
    this.soulstream = new SoulstreamClient({
      baseUrl: opts.soulstreamBaseUrl,
      authToken: opts.soulstreamAuthToken,
      profile: opts.soulstreamProfile,
      folderId: opts.soulstreamFolderId,
      model: opts.soulstreamModel,
      // 시스템 발신 워커임을 명시 — orch push 화이트리스트(slack/browser/soul-app) 외로
      // 자연 차단되어 사용자에게 알림이 가지 않는다.
      callerInfo: {
        source: "agent",
        agent_id: "remiel",
        purpose: "intent-interpretation",
      },
    });
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.idleIntervalMs = opts.idleIntervalMs ?? IDLE_INTERVAL_MS;
    this.targetWindow = opts.targetWindow ?? 15;
    this.priorWindow = opts.priorWindow ?? 5;
    this.preferredNodeId = opts.soulstreamPreferredNodeId;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("[InterpretationWorker] Started");

    while (this.running) {
      try {
        const channels = await this.getEnabledChannels();
        let didWork = false;

        for (const channel of channels) {
          if (!this.running) break;
          if (this.channelLocks.has(channel.id)) continue;

          const result = await this.processChannel(channel.id, channel.name);
          if (result) didWork = true;
        }

        const interval = didWork ? this.pollIntervalMs : this.idleIntervalMs;
        await this.sleep(interval);
      } catch (err) {
        console.error("[InterpretationWorker] Loop error:", err);
        await this.sleep(this.pollIntervalMs);
      }
    }

    console.log("[InterpretationWorker] Stopped");
  }

  stop(): void {
    this.running = false;
  }

  /** 프롬프트 캐시 무효화 (대시보드에서 프롬프트 수정 시 호출) */
  invalidatePromptCache(): void {
    this.promptCache = null;
  }

  /**
   * 현재 유효한 노드 ID를 반환한다.
   * rate-limit backoff 중이면 undefined를 반환하여 least-sessions 폴백을 유도한다.
   */
  private getEffectiveNodeId(): string | undefined {
    if (!this.preferredNodeId) return undefined;
    if (Date.now() < this.rateLimitedUntil) {
      return undefined; // backoff 중 → least-sessions
    }
    return this.preferredNodeId;
  }

  /**
   * 채널 하나를 처리한다.
   * @returns true if interpretation was executed, false if nothing to do
   */
  private async processChannel(channelId: string, channelName: string): Promise<boolean> {
    this.channelLocks.add(channelId);
    try {
      // 최근 targetWindow + priorWindow 메시지 조회
      const allMessages = await this.getRecentMessages(
        channelId,
        this.targetWindow + this.priorWindow,
      );
      if (allMessages.length === 0) return false;

      // prior / target 분할
      const priorCount = Math.max(0, allMessages.length - this.targetWindow);
      const priorMessages = allMessages.slice(0, priorCount);
      const targetMessages = allMessages.slice(priorCount);

      // 각 메시지의 기존 해석 로드
      const [priorWithInterps, targetWithInterps] = await Promise.all([
        this.loadInterpretations(priorMessages),
        this.loadInterpretations(targetMessages),
      ]);

      // 미해석 메시지 토큰 계산
      const uninterpreted = targetWithInterps.filter((m) => !m.existing_interpretation);
      if (uninterpreted.length === 0) return false;

      const uninterpretedTokens = uninterpreted.reduce(
        (sum, m) => sum + estimateTokens(m.message.content),
        0,
      );

      // 트리거 조건:
      //   ≥500 토큰 → 즉시 처리
      //   <500 토큰 → idle 간격(1분) 경과 후 처리
      if (uninterpretedTokens < TOKEN_THRESHOLD) {
        const lastTs = this.lastProcessed.get(channelId) ?? 0;
        if (Date.now() - lastTs < this.idleIntervalMs) {
          return false;
        }
      }

      // 프롬프트 로드
      const promptTemplate = await this.getPromptTemplate();

      // 프롬프트 조립
      const prompt = buildPrompt({
        promptTemplate,
        priorMessages: priorWithInterps,
        targetMessages: targetWithInterps,
        channelName,
      });

      // 소울스트림 세션 실행
      let responseText: string;
      try {
        const nodeId = this.getEffectiveNodeId();
        const result = await this.soulstream.run(prompt, { nodeId });
        responseText = result.text;
      } catch (err) {
        const errMsg = String(err);
        console.error(
          `[InterpretationWorker] Soulstream session failed for channel ${channelId}:`,
          err,
        );
        // Rate limit → rateLimitedUntil 설정 + 긴 backoff 후 재시도
        if (errMsg.includes("hit your limit") || errMsg.includes("rate limit")) {
          this.rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
          const nodeInfo = this.preferredNodeId ? ` (preferred: ${this.preferredNodeId})` : '';
          console.log(`[InterpretationWorker] Rate limited${nodeInfo} — backing off ${RATE_LIMIT_BACKOFF_MS / 60000}min`);
          await this.sleep(RATE_LIMIT_BACKOFF_MS);
        }
        return false;
      }

      // 응답 파싱
      let interpretations: ContextInterpretation[];
      try {
        const parsed = parseResponse(responseText);
        interpretations = parsed.interpretations;
      } catch (err) {
        if (err instanceof ParseError) {
          console.error(
            `[InterpretationWorker] Parse failed for channel ${channelId}:`,
            err.message,
          );
          // raw 응답을 별도 저장
          await this.storeRawFallback(channelId, err.raw);
        } else {
          console.error(
            `[InterpretationWorker] Unexpected parse error for channel ${channelId}:`,
            err,
          );
        }
        return false;
      }

      // 변경 감지: 기존과 동일한 해석은 저장하지 않음
      const existingMap = new Map<string, MessageWithInterpretation>();
      for (const item of targetWithInterps) {
        existingMap.set(item.message.id, item);
      }
      const changed = detectChanges(interpretations, existingMap);

      // 변경된 해석만 저장
      for (const interp of changed) {
        await this.interpretationService.store({
          channel_id: channelId,
          message_id: interp.message_id,
          type: "context",
          content: interp.summary,
          metadata: {
            addressees: interp.addressees,
            intent: interp.intent,
            confidence: interp.confidence,
            adversarial_note: interp.adversarial_note,
          },
        });
      }

      if (changed.length > 0) {
        console.log(
          `[InterpretationWorker] Channel ${channelId}: ${changed.length}/${interpretations.length} interpretations stored`,
        );
      }

      this.lastProcessed.set(channelId, Date.now());
      return true;
    } finally {
      this.channelLocks.delete(channelId);
    }
  }

  private async getEnabledChannels(): Promise<{ id: string; name: string }[]> {
    const { rows } = await this.pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM channels",
    );
    return rows;
  }

  private async getRecentMessages(channelId: string, limit: number): Promise<Message[]> {
    const { rows } = await this.pool.query<Message>(
      `SELECT * FROM messages
       WHERE channel_id = $1 AND is_deleted = false AND thread_ts IS NULL
         AND content != '' AND content IS NOT NULL
       ORDER BY ts DESC
       LIMIT $2`,
      [channelId, limit],
    );
    // DESC로 가져왔으므로 ASC로 반전
    return rows.reverse();
  }

  private async loadInterpretations(
    messages: Message[],
  ): Promise<MessageWithInterpretation[]> {
    const result: MessageWithInterpretation[] = [];
    for (const msg of messages) {
      const interps = await this.getContextInterpretations(msg.id);
      result.push(toPromptMessage(msg, interps));
    }
    return result;
  }

  private async getContextInterpretations(messageId: string): Promise<Interpretation[]> {
    const { rows } = await this.pool.query<Interpretation>(
      "SELECT * FROM interpretations WHERE message_id = $1 AND type = 'context' ORDER BY created_at ASC",
      [messageId],
    );
    return rows;
  }

  private async getPromptTemplate(): Promise<string> {
    if (this.promptCache) return this.promptCache;

    const { rows } = await this.pool.query<{ content: string }>(
      "SELECT content FROM interpretation_prompts WHERE key = 'context_interpretation'",
    );

    const template = rows[0]?.content ?? DEFAULT_INTERPRETATION_PROMPT;
    this.promptCache = template;
    return template;
  }

  private async storeRawFallback(channelId: string, raw: string): Promise<void> {
    try {
      await this.interpretationService.store({
        channel_id: channelId,
        type: "context_parse_error",
        content: raw.slice(0, 10000),
        metadata: { error: true },
      });
    } catch (err) {
      console.error("[InterpretationWorker] Failed to store raw fallback:", err);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
