import { describe, it, expect, vi, afterEach } from "vitest";
import { SoulstreamClient } from "../src/worker/SoulstreamClient.js";

// 빈 SSE 스트림을 반환하는 mock body — run()이 즉시 종료한다.
function emptyMockBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function sseMockBody(
  events: Array<{ event: string; data: Record<string, unknown> }>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

// fetch를 mock하고 호출 인자를 검사할 수 있도록 stub. createRes/streamRes 두 번 호출됨.
function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/api/sessions")) {
      return new Response(JSON.stringify({ agentSessionId: "sess-1", nodeId: "node-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // SSE events 스트림은 즉시 닫음
    return new Response(emptyMockBody(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("SoulstreamClient — caller_info wire 운반", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("callerInfo 옵션이 있으면 POST /api/sessions body에 caller_info로 박힌다", async () => {
    const fetchMock = stubFetch();

    const client = new SoulstreamClient({
      baseUrl: "http://orch.test",
      authToken: "tok",
      callerInfo: {
        source: "agent",
        agent_id: "remiel",
        purpose: "intent-interpretation",
      },
    });

    await client.run("hello");

    // 첫 호출이 POST /api/sessions
    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(createUrl).toBe("http://orch.test/api/sessions");
    const body = JSON.parse(String(createInit?.body));
    expect(body.caller_info).toEqual({
      source: "agent",
      agent_id: "remiel",
      purpose: "intent-interpretation",
    });
  });

  it("callerInfo 옵션이 없으면 body에 caller_info 키가 부재한다 (orch fallback 보존)", async () => {
    const fetchMock = stubFetch();

    const client = new SoulstreamClient({
      baseUrl: "http://orch.test",
      authToken: "tok",
    });

    await client.run("hello");

    const [, createInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(createInit?.body));
    expect(body).not.toHaveProperty("caller_info");
  });
});

describe("SoulstreamClient — 현행 응답 SSE wire", () => {
  it("text_delta 없이 assistant_message와 complete.result만 와도 최종 응답을 반환한다", async () => {
    const client = new SoulstreamClient({
      baseUrl: "http://orch.test",
      authToken: "tok",
    });
    const finalText = '{"interpretations":[{"message_id":"m1"}]}';
    const body = sseMockBody([
      {
        event: "assistant_message",
        data: { type: "assistant_message", content: finalText },
      },
      {
        event: "result",
        data: { type: "result", output: finalText, success: true },
      },
      {
        event: "complete",
        data: { type: "complete", result: finalText },
      },
    ]);

    await expect(client.consumeSSE(body, "sess-current-wire")).resolves.toBe(finalText);
  });

  it("라이브 text_delta와 최종 응답이 함께 오면 최종 응답을 중복 없이 반환한다", async () => {
    const client = new SoulstreamClient({
      baseUrl: "http://orch.test",
      authToken: "tok",
    });
    const body = sseMockBody([
      {
        event: "text_delta",
        data: { type: "text_delta", text: "partial" },
      },
      {
        event: "assistant_message",
        data: { type: "assistant_message", content: "final" },
      },
      {
        event: "complete",
        data: { type: "complete", result: "final" },
      },
    ]);

    await expect(client.consumeSSE(body, "sess-live-and-final")).resolves.toBe("final");
  });
});
