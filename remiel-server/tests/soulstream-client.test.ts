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
