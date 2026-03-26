import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseRequests, DelegationManager } from "../src/delegation.js";

// ---------------------------------------------------------------------------
// parseRequests
// ---------------------------------------------------------------------------

describe("parseRequests", () => {
  it("단일 <request> 태그를 추출한다", () => {
    const text = "some text <request>배경: 테스트\n원하는 결과: 성공</request> done";
    expect(parseRequests(text)).toEqual(["배경: 테스트\n원하는 결과: 성공"]);
  });

  it("복수 <request> 태그를 모두 추출한다", () => {
    const text = "<request>첫 번째</request> blah <request>두 번째</request>";
    expect(parseRequests(text)).toEqual(["첫 번째", "두 번째"]);
  });

  it("<request> 태그가 없으면 빈 배열을 반환한다", () => {
    expect(parseRequests("아무 태그도 없음")).toEqual([]);
  });

  it("빈 <request> 태그는 무시한다", () => {
    const text = "<request>  </request><request>내용 있음</request>";
    expect(parseRequests(text)).toEqual(["내용 있음"]);
  });

  it("중첩되지 않은 태그만 처리한다 (첫 번째 닫는 태그에서 종료)", () => {
    const text = "<request>outer <request>inner</request> rest</request>";
    // regex는 non-greedy — 첫 번째 닫기 태그에서 멈춤
    const results = parseRequests(text);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toContain("outer");
  });
});

// ---------------------------------------------------------------------------
// DelegationManager.getPreamble
// ---------------------------------------------------------------------------

describe("DelegationManager.getPreamble", () => {
  let manager: DelegationManager;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      body: null,
    }));
    manager = new DelegationManager("http://localhost:4105", "token", "agent-id");
  });

  afterEach(() => {
    manager.destroy();
    vi.unstubAllGlobals();
  });

  it("진행 중 의뢰(텍스트 없음) → '처리 중' 형식", async () => {
    // delegate는 SSE 스트림 실패를 background에서 조용히 처리
    const id = await manager.delegate("의뢰 내용 테스트", "");
    const preamble = manager.getPreamble();
    expect(preamble).toContain("의뢰 중");
    expect(preamble).toContain("처리 중");
    expect(preamble).toContain(id);
  });

  it("진행 중 의뢰(텍스트 있음) → '서소영: ...' 형식", async () => {
    // Arrange: fetch가 text_delta 이벤트를 보내는 스트림을 반환
    const encoder = new TextEncoder();
    const sseData =
      "event: text_delta\ndata: {\"text\": \"부분 응답 텍스트\"}\n\n";
    let called = false;
    const mockBody = {
      getReader: () => ({
        read: async () => {
          if (!called) {
            called = true;
            return { done: false, value: encoder.encode(sseData) };
          }
          // Keep hanging — never complete
          return new Promise<{ done: boolean; value: Uint8Array | undefined }>(() => {});
        },
        releaseLock: () => {},
      }),
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: mockBody,
    }));

    manager = new DelegationManager("http://localhost:4105", "token", "agent-id");
    const id = await manager.delegate("의뢰 내용 테스트", "");

    // Wait a tick for the SSE stream to process
    await new Promise((r) => setTimeout(r, 50));

    const preamble = manager.getPreamble();
    expect(preamble).toContain("의뢰 중");
    expect(preamble).toContain("서소영:");
    expect(preamble).toContain("부분 응답 텍스트");
    expect(preamble).toContain(id);
  });

  it("완료된 의뢰 → '의뢰 완료' 형식", async () => {
    const encoder = new TextEncoder();
    const sseData =
      "event: complete\ndata: {\"result\": \"최종 결과입니다\"}\n\n";
    let called = false;
    const mockBody = {
      getReader: () => ({
        read: async () => {
          if (!called) {
            called = true;
            return { done: false, value: encoder.encode(sseData) };
          }
          return { done: true, value: undefined };
        },
        releaseLock: () => {},
      }),
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: mockBody,
    }));

    manager = new DelegationManager("http://localhost:4105", "token", "agent-id");
    const id = await manager.delegate("완료 테스트", "");

    // Wait for SSE stream to complete
    await new Promise((r) => setTimeout(r, 50));

    const preamble = manager.getPreamble();
    expect(preamble).toContain("의뢰 완료");
    expect(preamble).toContain("최종 결과입니다");
    expect(preamble).toContain(id);
  });

  it("실패한 의뢰 → '의뢰 실패' 형식", async () => {
    // fetch 자체가 실패하면 delegate 내부에서 catch → status='failed'
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    manager = new DelegationManager("http://localhost:4105", "token", "agent-id");
    const id = await manager.delegate("실패 테스트", "");

    await new Promise((r) => setTimeout(r, 50));

    const preamble = manager.getPreamble();
    expect(preamble).toContain("의뢰 실패");
    expect(preamble).toContain(id);
  });

  it("의뢰가 없으면 빈 문자열을 반환한다", () => {
    expect(manager.getPreamble()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// DelegationManager — 동시 의뢰 제한
// ---------------------------------------------------------------------------

describe("DelegationManager — 동시 의뢰 최대 3개", () => {
  let manager: DelegationManager;

  beforeEach(() => {
    // fetch가 절대 완료되지 않는 스트림 반환 (pending 유지)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => new Promise(() => {}),
          releaseLock: () => {},
        }),
      },
    }));
    manager = new DelegationManager("http://localhost:4105", "token", "agent-id");
  });

  afterEach(() => {
    manager.destroy();
    vi.unstubAllGlobals();
  });

  it("3개까지는 정상 등록된다", async () => {
    await manager.delegate("첫 번째", "");
    await manager.delegate("두 번째", "");
    await manager.delegate("세 번째", "");

    const preamble = manager.getPreamble();
    const count = (preamble.match(/의뢰 중/g) ?? []).length;
    expect(count).toBe(3);
  });

  it("4번째 의뢰는 에러를 던진다", async () => {
    await manager.delegate("첫 번째", "");
    await manager.delegate("두 번째", "");
    await manager.delegate("세 번째", "");

    await expect(manager.delegate("네 번째", "")).rejects.toThrow(
      /최대.*3.*초과/,
    );
  });
});

// ---------------------------------------------------------------------------
// DelegationManager — 만료 로직
// ---------------------------------------------------------------------------

describe("DelegationManager — 만료 로직", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => new Promise(() => {}),
          releaseLock: () => {},
        }),
      },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("1시간 이상 경과한 pending 의뢰는 timeout으로 처리되어 preamble에서 제거된다", async () => {
    const manager = new DelegationManager(
      "http://localhost:4105",
      "token",
      "agent-id",
    );

    await manager.delegate("오래된 의뢰", "");

    // Preamble에 있어야 함
    expect(manager.getPreamble()).toContain("의뢰 중");

    // 1시간 + 1분 경과 시뮬레이션 (cleanup interval 60s × 61 = 3660s)
    vi.advanceTimersByTime(61 * 60 * 1000);

    // timeout 처리 후 preamble에서 제거
    expect(manager.getPreamble()).toBe("");

    manager.destroy();
  });
});
