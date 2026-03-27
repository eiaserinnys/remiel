import type { App } from "@slack/bolt";

const MAX_CONCURRENT = 3;
const TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

interface DelegationRequest {
  id: string;
  content: string;
  channelId: string;
  status: "pending" | "completed" | "failed" | "timeout";
  partialText: string;
  finalResult?: string;
  createdAt: number;
  abortController: AbortController;
}

export type OnCompleteCallback = (
  channelId: string,
  requestId: string,
  status: "completed" | "failed",
  finalResult?: string,
) => void | Promise<void>;

export function parseRequests(text: string): string[] {
  const matches = [...text.matchAll(/<request>([\s\S]*?)<\/request>/g)];
  return matches.map((m) => m[1].trim()).filter((s) => s.length > 0);
}

export function stripRequests(text: string): string {
  return text.replace(/<request>[\s\S]*?<\/request>/g, "").trim();
}

export class DelegationManager {
  private requests = new Map<string, DelegationRequest>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnCompleteCallback;
  private app?: App;

  constructor(
    private soulstreamUrl: string,
    private token: string,
    private agentId: string,
    onComplete?: OnCompleteCallback,
    private dumpChannelId?: string,
  ) {
    this.onComplete = onComplete;
    this.cleanupInterval = this.scheduleCleanup();
  }

  setApp(app: App): void {
    this.app = app;
  }

  setOnComplete(callback: OnCompleteCallback): void {
    this.onComplete = callback;
  }

  private async dump(text: string): Promise<void> {
    if (!this.dumpChannelId || !this.app) return;
    try {
      await this.app.client.chat.postMessage({ channel: this.dumpChannelId, text });
    } catch { /* 덤프 실패는 무시 */ }
  }

  private generateId(): string {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 6);
    return `req-${ts}-${rand}`;
  }

  async delegate(content: string, channelContext: string, channelId = ""): Promise<string> {
    const pending = [...this.requests.values()].filter(
      (r) => r.status === "pending",
    );
    if (pending.length >= MAX_CONCURRENT) {
      throw new Error(
        `동시 의뢰 최대 ${MAX_CONCURRENT}개를 초과합니다.`,
      );
    }

    const id = this.generateId();
    const abortController = new AbortController();

    const request: DelegationRequest = {
      id,
      content,
      channelId,
      status: "pending",
      partialText: "",
      createdAt: Date.now(),
      abortController,
    };

    this.requests.set(id, request);

    void this.dump(`[의뢰 시작] id: ${id}\n내용: ${content.slice(0, 100)}`);

    const prompt = channelContext
      ? `${channelContext}\n\n레미엘 채널에서 다음 의뢰가 접수되었습니다:\n${content}`
      : `레미엘 채널에서 다음 의뢰가 접수되었습니다:\n${content}`;

    this.startSSEStream(id, prompt).catch((err) => {
      console.error(`[Delegation] SSE stream error for ${id}:`, err);
      const req = this.requests.get(id);
      if (req && req.status === "pending") {
        req.status = "failed";
        void this.onComplete?.(req.channelId, id, "failed", undefined);
      }
    });

    return id;
  }

  getPreamble(): string {
    const lines: string[] = [];

    for (const req of this.requests.values()) {
      if (req.status === "timeout") continue;

      const shortContent =
        req.content.slice(0, 30) + (req.content.length > 30 ? "..." : "");

      if (req.status === "pending") {
        if (req.partialText) {
          const shortText = req.partialText.slice(0, 100);
          const ellipsis = req.partialText.length > 100 ? "..." : "";
          lines.push(
            `[의뢰 중 (${req.id}): '${shortContent}' - 서소영: '${shortText}${ellipsis}']`,
          );
        } else {
          lines.push(`[의뢰 중 (${req.id}): '${shortContent}' - 처리 중]`);
        }
      } else if (req.status === "completed") {
        lines.push(
          `[의뢰 완료 (${req.id}): '${shortContent}' → 서소영: '${req.finalResult ?? ""}']`,
        );
      } else if (req.status === "failed") {
        lines.push(`[의뢰 실패 (${req.id}): '${shortContent}']`);
      }
    }

    return lines.length > 0 ? lines.join("\n") + "\n" : "";
  }

  private async startSSEStream(
    requestId: string,
    prompt: string,
  ): Promise<void> {
    const req = this.requests.get(requestId);
    if (!req) return;

    const response = await fetch(`${this.soulstreamUrl}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        prompt,
        use_mcp: true,
        agent_session_id: this.agentId,
        profile: this.agentId,
      }),
      signal: req.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer — split by double newline
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const eventBlock of events) {
          if (!eventBlock.trim()) continue;

          let eventType = "";
          let dataStr = "";

          for (const line of eventBlock.split("\n")) {
            if (line.startsWith("event: ")) {
              eventType = line.slice("event: ".length).trim();
            } else if (line.startsWith("data: ")) {
              dataStr = line.slice("data: ".length).trim();
            }
          }

          if (!eventType || !dataStr) continue;

          try {
            const data = JSON.parse(dataStr) as Record<string, unknown>;
            const currentReq = this.requests.get(requestId);
            if (!currentReq) return;

            if (eventType === "text_delta" && typeof data["text"] === "string") {
              currentReq.partialText += data["text"];
            } else if (eventType === "complete") {
              currentReq.status = "completed";
              currentReq.finalResult =
                typeof data["result"] === "string"
                  ? data["result"]
                  : currentReq.partialText;
              void this.dump(`[의뢰 완료] id: ${requestId}\n결과: ${(currentReq.finalResult ?? "").slice(0, 200)}`);
              void this.onComplete?.(currentReq.channelId, requestId, "completed", currentReq.finalResult);
              return;
            } else if (eventType === "error") {
              currentReq.status = "failed";
              void this.dump(`[의뢰 실패] id: ${requestId}`);
              void this.onComplete?.(currentReq.channelId, requestId, "failed", undefined);
              return;
            }
          } catch {
            // JSON parse error — skip malformed event
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 스트림 종료 후 buffer에 남은 마지막 이벤트 처리 (trailing \n\n 없는 경우 대비)
    if (buffer.trim()) {
      let eventType = "";
      let dataStr = "";
      for (const line of buffer.split("\n")) {
        if (line.startsWith("event: ")) eventType = line.slice("event: ".length).trim();
        else if (line.startsWith("data: ")) dataStr = line.slice("data: ".length).trim();
      }
      if (eventType && dataStr) {
        try {
          const data = JSON.parse(dataStr) as Record<string, unknown>;
          const currentReq = this.requests.get(requestId);
          if (currentReq && currentReq.status === "pending") {
            if (eventType === "complete") {
              currentReq.status = "completed";
              currentReq.finalResult =
                typeof data["result"] === "string" ? data["result"] : currentReq.partialText;
              void this.dump(`[의뢰 완료] id: ${requestId}\n결과: ${(currentReq.finalResult ?? "").slice(0, 200)}`);
              void this.onComplete?.(currentReq.channelId, requestId, "completed", currentReq.finalResult);
              return;
            } else if (eventType === "error") {
              currentReq.status = "failed";
              void this.dump(`[의뢰 실패] id: ${requestId}`);
              void this.onComplete?.(currentReq.channelId, requestId, "failed", undefined);
              return;
            }
          }
        } catch {
          // malformed — skip
        }
      }
    }

    // Stream ended without a complete event
    const currentReq = this.requests.get(requestId);
    if (currentReq && currentReq.status === "pending") {
      currentReq.status = "failed";
      void this.dump(`[의뢰 실패] id: ${requestId}`);
      void this.onComplete?.(currentReq.channelId, requestId, "failed", undefined);
    }
  }

  private scheduleCleanup(): ReturnType<typeof setInterval> {
    return setInterval(() => {
      const now = Date.now();
      for (const [id, req] of this.requests.entries()) {
        if (req.status === "pending" && now - req.createdAt > TIMEOUT_MS) {
          req.abortController.abort();
          req.status = "timeout";
          this.requests.delete(id);
          void this.dump(`[의뢰 타임아웃] id: ${id}`);
          console.log(`[Delegation] Request ${id} timed out`);
        }
      }
    }, 60 * 1000);
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const req of this.requests.values()) {
      if (req.status === "pending") {
        req.abortController.abort();
      }
    }
  }
}
