/**
 * Soulstream orch-server 클라이언트.
 * POST /api/sessions → SSE 스트리밍으로 Claude Code 세션을 실행하고
 * 텍스트 응답을 축적하여 반환한다.
 */

export interface SoulstreamClientOpts {
  /** orch-server 베이스 URL (예: https://soulstream.eiaserinnys.me) */
  baseUrl: string;
  /** Bearer 토큰 */
  authToken: string;
  /** 세션 생성 시 사용할 profile (agent_id) */
  profile?: string;
  /** 세션 생성 시 사용할 folder ID */
  folderId?: string;
  /** SSE 타임아웃 (ms). 기본 5분 */
  timeoutMs?: number;
  /** 세션 생성 시 사용할 Claude 모델 (예: 'sonnet-4.6') */
  model?: string;
  /** 발신자 정보. orch는 push 화이트리스트(slack/browser/soul-app)에서 caller_info.source를
   *  기준으로 알림 발사 여부를 결정한다 (orch-server push/notifier.py:120-124,172-175).
   *  source='agent'를 박으면 자연 차단된다. 미전달 시 orch가 build_browser_caller_info로
   *  fallback하여 source='browser'로 강제되어 알림이 발사되므로, 시스템 발신 워커는
   *  반드시 명시한다. */
  callerInfo?: Record<string, unknown>;
}

export interface SoulstreamSessionResult {
  text: string;
  sessionId: string;
}

export class SoulstreamClient {
  private baseUrl: string;
  private authToken: string;
  private profile?: string;
  private folderId?: string;
  private timeoutMs: number;
  private model?: string;
  private callerInfo?: Record<string, unknown>;

  constructor(opts: SoulstreamClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.authToken = opts.authToken;
    this.profile = opts.profile;
    this.folderId = opts.folderId;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.model = opts.model;
    this.callerInfo = opts.callerInfo;
  }

  /**
   * 소울스트림 세션을 생성하고 SSE 스트리밍으로 텍스트 응답을 수집한다.
   */
  async run(prompt: string, opts?: { systemPrompt?: string; nodeId?: string }): Promise<SoulstreamSessionResult> {
    // 1. 세션 생성
    const createRes = await fetch(`${this.baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify({
        prompt,
        profile: this.profile,
        folderId: this.folderId,
        system_prompt: opts?.systemPrompt,
        use_mcp: false,
        ...(opts?.nodeId && { nodeId: opts.nodeId }),
        ...(this.model && { model: this.model }),
        // callerInfo 미전달 시에는 키를 누락하여 orch fallback(build_browser_caller_info)을
        // 그대로 보존한다. 시스템 발신 워커는 반드시 옵션에 명시한다.
        ...(this.callerInfo && { caller_info: this.callerInfo }),
      }),
    });

    if (!createRes.ok) {
      const body = await createRes.text().catch(() => "");
      throw new Error(`Soulstream session create failed: ${createRes.status} ${body}`);
    }

    const { agentSessionId } = (await createRes.json()) as {
      agentSessionId: string;
      nodeId: string;
    };

    // 2. SSE 스트리밍
    return this.streamEvents(agentSessionId);
  }

  /**
   * SSE 이벤트 스트림에서 텍스트를 축적한다.
   * text_delta → 텍스트 축적
   * complete → 종료
   * error → 에러 throw
   */
  private async streamEvents(sessionId: string): Promise<SoulstreamSessionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/events`, {
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE stream failed: ${res.status}`);
      }

      const text = await this.consumeSSE(res.body, sessionId);
      return { text, sessionId };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * ReadableStream에서 SSE 이벤트를 파싱하여 텍스트를 축적한다.
   * 이 메서드는 테스트 용이성을 위해 분리했다.
   */
  async consumeSSE(body: ReadableStream<Uint8Array>, sessionId: string): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    let currentEvent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 파싱: 줄 단위
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;

          const result = parseSSEData(currentEvent, dataStr);
          if (result.type === "text") {
            accumulated += result.text;
          } else if (result.type === "complete") {
            return accumulated;
          } else if (result.type === "error") {
            throw new Error(`Soulstream session ${sessionId} error: ${result.message}`);
          }
        } else if (line.trim() === "") {
          // 이벤트 경계 — currentEvent 리셋
          currentEvent = "";
        }
      }
    }

    // 스트림이 complete 없이 끝난 경우
    return accumulated;
  }
}

/** SSE data 파싱 결과 */
export type SSEParseResult =
  | { type: "text"; text: string }
  | { type: "complete" }
  | { type: "error"; message: string }
  | { type: "ignored" };

/**
 * 단일 SSE 이벤트의 data를 파싱한다.
 * 순수 함수로 분리하여 단위 테스트가 용이하다.
 */
export function parseSSEData(event: string, dataStr: string): SSEParseResult {
  try {
    const data = JSON.parse(dataStr);

    if (event === "text_delta" || data.type === "text_delta") {
      return { type: "text", text: data.text ?? data.delta ?? "" };
    }

    if (event === "complete" || data.type === "complete") {
      return { type: "complete" };
    }

    if (event === "error" || data.type === "error") {
      return { type: "error", message: data.message ?? data.error ?? "Unknown error" };
    }

    return { type: "ignored" };
  } catch {
    // JSON 파싱 실패 — data가 plain text인 경우
    if (event === "text_delta") {
      return { type: "text", text: dataStr };
    }
    return { type: "ignored" };
  }
}
