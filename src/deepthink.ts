import type { App } from "@slack/bolt";
import type { Config } from "./config.js";
import { askClaudeDeepThink } from "./claude.js";

const MAX_CONCURRENT = 3;
const TIMEOUT_MS = 5 * 60 * 1000; // 5분

interface DeepThinkRequest {
  id: string;
  query: string;
  channelId: string;
  status: "pending" | "completed" | "failed" | "timeout";
  result?: string;
  createdAt: number;
}

type OnCompleteCallback = (
  channelId: string,
  requestId: string,
  status: "completed" | "failed",
  result?: string,
) => void | Promise<void>;

export class DeepThinkManager {
  private requests = new Map<string, DeepThinkRequest>();
  private onComplete: OnCompleteCallback | null = null;
  private cleanupInterval: ReturnType<typeof setInterval>;
  private app!: App;

  constructor(
    private config: Config,
    private dumpChannelId?: string,
  ) {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  setApp(app: App): void {
    this.app = app;
  }

  setOnComplete(cb: OnCompleteCallback): void {
    this.onComplete = cb;
  }

  async think(query: string, channelContext: string, channelId: string): Promise<string> {
    const pending = [...this.requests.values()].filter(r => r.status === "pending");
    if (pending.length >= MAX_CONCURRENT) {
      throw new Error("MAX_CONCURRENT reached");
    }
    const id = `dt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.requests.set(id, { id, query, channelId, status: "pending", createdAt: Date.now() });
    this.runDeepThink(id, query, channelContext).catch(err =>
      console.error(`[DeepThink] Uncaught error for ${id}:`, err),
    );
    return id;
  }

  private async runDeepThink(id: string, query: string, channelContext: string): Promise<void> {
    const req = this.requests.get(id)!;
    await this.dump(`[딥씽크 시작] id: ${id}\n쿼리: ${query.slice(0, 100)}`);
    const startAt = Date.now();
    const prompt = [
      "=== 채널 컨텍스트 (최근 30개 메시지) ===",
      channelContext,
      "",
      "=== 분석 요청 ===",
      query,
    ].join("\n");
    try {
      const result = await askClaudeDeepThink(this.config, prompt);
      const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
      if (result) {
        req.status = "completed";
        req.result = result;
        await this.dump(`[딥씽크 완료] id: ${id} (${elapsed}s)\n결과: ${result.slice(0, 200)}`);
        await this.onComplete?.(req.channelId, id, "completed", result);
      } else {
        req.status = "failed";
        await this.dump(`[딥씽크 실패] id: ${id} — 결과 없음`);
        await this.onComplete?.(req.channelId, id, "failed");
      }
    } catch (err) {
      req.status = "failed";
      await this.dump(`[딥씽크 실패] id: ${id}\n에러: ${String(err).slice(0, 200)}`);
      await this.onComplete?.(req.channelId, id, "failed");
    }
  }

  getPreamble(): string {
    const lines: string[] = [];
    for (const req of this.requests.values()) {
      if (req.status === "timeout") continue;
      if (req.status === "pending") {
        lines.push(`[딥씽크 진행 중 (${req.id}): '${req.query.slice(0, 30)}' — 분석 중]`);
      } else if (req.status === "completed") {
        lines.push(`[딥씽크 완료 (${req.id}): '${req.query.slice(0, 30)}' → ${req.result?.slice(0, 100)}]`);
      } else {
        lines.push(`[딥씽크 실패 (${req.id}): '${req.query.slice(0, 30)}']`);
      }
    }
    return lines.join("\n");
  }

  private async dump(text: string): Promise<void> {
    if (!this.dumpChannelId || !this.app) return;
    try {
      await this.app.client.chat.postMessage({ channel: this.dumpChannelId, text });
    } catch { /* 덤프 실패는 무시 */ }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, req] of this.requests.entries()) {
      if (req.status === "pending" && now - req.createdAt > TIMEOUT_MS) {
        req.status = "timeout";
        this.dump(`[딥씽크 타임아웃] id: ${id}`).catch(() => {});
        this.onComplete?.(req.channelId, id, "failed");
      }
      if (req.status !== "pending" && now - req.createdAt > 30 * 60_000) {
        this.requests.delete(id);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
