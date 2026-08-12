import { describe, it, expect, vi } from "vitest";
import { parseSSEData } from "../src/worker/SoulstreamClient.js";
import {
  buildPrompt,
  estimateTokens,
  toPromptMessage,
  DEFAULT_INTERPRETATION_PROMPT,
  ensureWindowContextOutputContract,
} from "../src/worker/buildPrompt.js";
import { parseResponse, detectChanges, ParseError } from "../src/worker/parseResponse.js";
import { InterpretationWorker } from "../src/worker/InterpretationWorker.js";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  getInterpretationStatus,
} from "../src/services/interpretationLookup.js";
import type { Message, Interpretation } from "../src/types/index.js";
import type { MessageWithInterpretation } from "../src/worker/buildPrompt.js";

// ─── SSE 파싱 ───

describe("parseSSEData", () => {
  it("text_delta 이벤트에서 텍스트를 추출한다", () => {
    const result = parseSSEData("text_delta", '{"type":"text_delta","text":"hello"}');
    expect(result).toEqual({ type: "text", text: "hello" });
  });

  it("text_delta의 delta 필드도 지원한다", () => {
    const result = parseSSEData("text_delta", '{"delta":"world"}');
    expect(result).toEqual({ type: "text", text: "world" });
  });

  it("complete 이벤트를 인식한다", () => {
    const result = parseSSEData("complete", '{"type":"complete"}');
    expect(result).toEqual({ type: "complete" });
  });

  it("assistant_message content를 최종 텍스트로 인식한다", () => {
    const result = parseSSEData(
      "assistant_message",
      '{"type":"assistant_message","content":"final answer"}',
    );
    expect(result).toEqual({ type: "final", text: "final answer" });
  });

  it("result output을 최종 텍스트로 인식한다", () => {
    const result = parseSSEData("result", '{"type":"result","output":"final answer"}');
    expect(result).toEqual({ type: "final", text: "final answer" });
  });

  it("complete result를 종료 시 최종 텍스트로 인식한다", () => {
    const result = parseSSEData("complete", '{"type":"complete","result":"final answer"}');
    expect(result).toEqual({ type: "complete", text: "final answer" });
  });

  it("error 이벤트에서 메시지를 추출한다", () => {
    const result = parseSSEData("error", '{"type":"error","message":"fail"}');
    expect(result).toEqual({ type: "error", message: "fail" });
  });

  it("알 수 없는 이벤트는 ignored로 처리한다", () => {
    const result = parseSSEData("thinking", '{"type":"thinking","text":"hmm"}');
    expect(result).toEqual({ type: "ignored" });
  });

  it("JSON 파싱 실패 시 text_delta 이벤트면 plain text로 처리한다", () => {
    const result = parseSSEData("text_delta", "plain text");
    expect(result).toEqual({ type: "text", text: "plain text" });
  });

  it("JSON 파싱 실패 시 text_delta가 아니면 ignored", () => {
    const result = parseSSEData("debug", "not json");
    expect(result).toEqual({ type: "ignored" });
  });

  it("event 없이 data.type으로 이벤트를 판별한다", () => {
    const result = parseSSEData("", '{"type":"text_delta","text":"hi"}');
    expect(result).toEqual({ type: "text", text: "hi" });
  });
});

// ─── 토큰 추정 ───

describe("estimateTokens", () => {
  it("text.length / 4 를 올림한다", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(2000))).toBe(500);
  });
});

// ─── 프롬프트 조립 ───

describe("buildPrompt", () => {
  it("템플릿의 플레이스홀더를 치환한다", () => {
    const result = buildPrompt({
      promptTemplate:
        "채널: {{CHANNEL_NAME}}\n{{PRIOR_MESSAGES}}\n{{TARGET_MESSAGES}}\nIDs:\n{{TARGET_IDS}}\n총 {{TARGET_COUNT}}개",
      priorMessages: [
        {
          message: {
            id: "m1",
            user_id: "U1",
            user_name: "alice",
            content: "hello",
            ts: "1000.0",
            is_bot: false,
          },
          existing_interpretation: null,
        },
      ],
      targetMessages: [
        {
          message: {
            id: "m2",
            user_id: "U2",
            user_name: "bob",
            content: "world",
            ts: "1001.0",
            is_bot: true,
          },
          existing_interpretation: {
            summary: "인사",
            intent: "인사",
            addressees: ["U1"],
            confidence: 0.9,
          },
        },
      ],
      channelName: "general",
    });

    expect(result).toContain("채널: general");
    expect(result).toContain("alice (U1)");
    expect(result).toContain("bob (U2)");
    expect(result).toContain("[봇]");
    expect(result).toContain("기존 해석");
    expect(result).toContain("총 1개");
  });

  it("빈 prior는 빈 문자열을 반환한다", () => {
    const result = buildPrompt({
      promptTemplate: "{{PRIOR_MESSAGES}}",
      priorMessages: [],
      targetMessages: [
        {
          message: {
            id: "m1",
            user_id: "U1",
            user_name: "a",
            content: "x",
            ts: "1.0",
            is_bot: false,
          },
          existing_interpretation: null,
        },
      ],
      channelName: "ch",
    });
    expect(result).toBe("");
  });

  it("기본 프롬프트는 window_context object 출력 계약을 포함한다", () => {
    expect(DEFAULT_INTERPRETATION_PROMPT).toContain('"window_context"');
    expect(DEFAULT_INTERPRETATION_PROMPT).toContain('"interpretations"');
  });

  it("오래된 DB 프롬프트에는 window_context 출력 계약을 덧붙인다", () => {
    const prompt = ensureWindowContextOutputContract("반드시 JSON 배열만 출력하십시오.");

    expect(prompt).toContain("반드시 JSON 배열만 출력하십시오.");
    expect(prompt).toContain('"window_context"');
    expect(prompt).toContain('"interpretations"');
    expect(prompt).toContain("배열 출력 지시보다 우선");
  });
});

// ─── toPromptMessage ───

describe("toPromptMessage", () => {
  const makeMsg = (overrides?: Partial<Message>): Message => ({
    id: "msg-1",
    channel_id: "C1",
    ts: "1000.0",
    thread_ts: null,
    user_id: "U1",
    user_name: "alice",
    avatar_url: null,
    content: "hello",
    attachments: [],
    reactions: [],
    is_bot: false,
    is_deleted: false,
    source_edited: false,
    enrichment_count: 0,
    reply_count: 0,
    latest_interpretation: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    ...overrides,
  });

  it("해석이 없으면 existing_interpretation은 null", () => {
    const result = toPromptMessage(makeMsg(), []);
    expect(result.existing_interpretation).toBeNull();
  });

  it("context 타입의 최신 해석을 사용한다", () => {
    const interps: Interpretation[] = [
      {
        id: "i1",
        channel_id: "C1",
        message_id: "msg-1",
        thread_ts: null,
        type: "context",
        content: "old summary",
        metadata: { intent: "old", addressees: [], confidence: 0.5 },
        created_at: "2026-01-01",
      },
      {
        id: "i2",
        channel_id: "C1",
        message_id: "msg-1",
        thread_ts: null,
        type: "context",
        content: "new summary",
        metadata: { intent: "new", addressees: ["U2"], confidence: 0.9 },
        created_at: "2026-01-02",
      },
    ];
    const result = toPromptMessage(makeMsg(), interps);
    expect(result.existing_interpretation?.intent).toBe("new");
    expect(result.existing_interpretation?.summary).toBe("new summary");
  });

  it("summary 타입의 해석은 무시한다", () => {
    const interps: Interpretation[] = [
      {
        id: "i1",
        channel_id: "C1",
        message_id: "msg-1",
        thread_ts: null,
        type: "summary",
        content: "not context",
        metadata: {},
        created_at: "2026-01-01",
      },
    ];
    const result = toPromptMessage(makeMsg(), interps);
    expect(result.existing_interpretation).toBeNull();
  });
});

// ─── 응답 파싱 ───

describe("parseResponse", () => {
  it("코드 블록 내 JSON 배열을 파싱한다", () => {
    const text = `Some preamble text
\`\`\`json
[{"message_id":"m1","addressees":["U1"],"intent":"질문","summary":"무엇인가를 물었다","confidence":0.9,"adversarial_note":null}]
\`\`\`
Some trailing text`;

    const { interpretations } = parseResponse(text);
    expect(interpretations).toHaveLength(1);
    expect(interpretations[0].message_id).toBe("m1");
    expect(interpretations[0].intent).toBe("질문");
    expect(interpretations[0].confidence).toBe(0.9);
  });

  it("베어 JSON 배열을 파싱한다", () => {
    const text =
      '[{"message_id":"m1","addressees":[],"intent":"잡담","summary":"그냥 대화","confidence":0.7,"adversarial_note":"수신자 불명확"}]';

    const { interpretations } = parseResponse(text);
    expect(interpretations).toHaveLength(1);
    expect(interpretations[0].adversarial_note).toBe("수신자 불명확");
  });

  it("앞뒤 산문 사이의 베어 JSON object를 파싱한다", () => {
    const text = `요청하신 해석입니다.
{"window_context":{"summary":"창 요약"},"interpretations":[{"message_id":"m1","addressees":[],"intent":"정보 공유","summary":"핵심을 공유했다","confidence":0.8}]}
이상입니다.`;

    const { interpretations, window_context } = parseResponse(text);
    expect(interpretations).toHaveLength(1);
    expect(interpretations[0].message_id).toBe("m1");
    expect(window_context?.summary).toBe("창 요약");
  });

  it("message_id가 없는 항목은 무시한다", () => {
    const text =
      '[{"addressees":[],"intent":"질문","summary":"test","confidence":0.5},{"message_id":"m2","addressees":[],"intent":"답변","summary":"ok","confidence":0.8}]';

    const { interpretations } = parseResponse(text);
    expect(interpretations).toHaveLength(1);
    expect(interpretations[0].message_id).toBe("m2");
  });

  it("빈 응답이면 raw를 보존한 ParseError를 던진다", () => {
    try {
      parseResponse("");
      throw new Error("ParseError가 필요합니다");
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).message).toBe("JSON payload를 찾을 수 없습니다");
      expect((err as ParseError).raw).toBe("");
    }
  });

  it("JSON이 없는 산문이면 raw를 보존한 ParseError를 던진다", () => {
    const raw = "JSON 대신 산문만 반환했습니다.";
    try {
      parseResponse(raw);
      throw new Error("ParseError가 필요합니다");
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).message).toBe("JSON payload를 찾을 수 없습니다");
      expect((err as ParseError).raw).toBe(raw);
    }
  });

  it("빈 배열이면 ParseError를 던진다", () => {
    expect(() => parseResponse("[]")).toThrow(ParseError);
  });

  it("confidence를 0~1 사이로 클램핑한다", () => {
    const text =
      '[{"message_id":"m1","addressees":[],"intent":"test","summary":"test","confidence":1.5}]';
    const { interpretations } = parseResponse(text);
    expect(interpretations[0].confidence).toBe(1);
  });

  it("window_context를 포함한 JSON object 응답을 파싱한다", () => {
    const text = `\`\`\`json
{
  "window_context": {
    "summary": "이번 창은 배포 순서 논의다",
    "candidate_angles": ["배포 순서 확인"],
    "open_loops": ["운영 prompt 갱신 필요"],
    "avoid_repetition_notes": ["같은 설명 반복 금지"],
    "participants_focus": ["U1은 결정권자"],
    "confidence": 0.82
  },
  "interpretations": [
    {
      "message_id": "m1",
      "addressees": [{"id": "U1", "name": "alice"}],
      "intent": "요청",
      "summary": "배포 순서를 묻는다",
      "confidence": 0.9,
      "adversarial_note": null
    }
  ]
}
\`\`\``;

    const { interpretations, window_context } = parseResponse(text);
    expect(interpretations).toHaveLength(1);
    expect(window_context?.summary).toBe("이번 창은 배포 순서 논의다");
    expect(window_context?.candidate_angles).toEqual(["배포 순서 확인"]);
    expect(window_context?.confidence).toBe(0.82);
  });

  it("object 응답에서도 유효한 per-message 해석이 없으면 ParseError를 던진다", () => {
    const text = JSON.stringify({
      window_context: {
        summary: "창 요약",
        candidate_angles: [],
        open_loops: [],
        avoid_repetition_notes: [],
        participants_focus: [],
        confidence: 0.8,
      },
      interpretations: [],
    });
    expect(() => parseResponse(text)).toThrow(ParseError);
  });
});

// ─── 변경 감지 ───

describe("detectChanges", () => {
  const makeExisting = (
    id: string,
    interp: MessageWithInterpretation["existing_interpretation"],
  ): MessageWithInterpretation => ({
    message: {
      id,
      user_id: "U1",
      user_name: "alice",
      content: "hello",
      ts: "1.0",
      is_bot: false,
    },
    existing_interpretation: interp,
  });

  it("기존 해석이 없는 메시지는 항상 변경으로 감지한다", () => {
    const existingMap = new Map([["m1", makeExisting("m1", null)]]);
    const newInterps = [
      {
        message_id: "m1",
        addressees: [],
        intent: "질문",
        summary: "test",
        confidence: 0.8,
        adversarial_note: null,
      },
    ];
    expect(detectChanges(newInterps, existingMap)).toHaveLength(1);
  });

  it("동일한 해석은 변경으로 감지하지 않는다", () => {
    const existingMap = new Map([
      [
        "m1",
        makeExisting("m1", {
          intent: "질문",
          summary: "test",
          addressees: ["U2"],
          confidence: 0.8,
        }),
      ],
    ]);
    const newInterps = [
      {
        message_id: "m1",
        addressees: ["U2"],
        intent: "질문",
        summary: "test",
        confidence: 0.8,
        adversarial_note: null,
      },
    ];
    expect(detectChanges(newInterps, existingMap)).toHaveLength(0);
  });

  it("intent가 변경되면 감지한다", () => {
    const existingMap = new Map([
      [
        "m1",
        makeExisting("m1", {
          intent: "질문",
          summary: "test",
          addressees: [],
          confidence: 0.8,
        }),
      ],
    ]);
    const newInterps = [
      {
        message_id: "m1",
        addressees: [],
        intent: "답변",
        summary: "test",
        confidence: 0.8,
        adversarial_note: null,
      },
    ];
    expect(detectChanges(newInterps, existingMap)).toHaveLength(1);
  });

  it("existingMap에 없는 메시지는 변경으로 감지한다", () => {
    const existingMap = new Map<string, MessageWithInterpretation>();
    const newInterps = [
      {
        message_id: "m99",
        addressees: [],
        intent: "질문",
        summary: "test",
        confidence: 0.5,
        adversarial_note: null,
      },
    ];
    expect(detectChanges(newInterps, existingMap)).toHaveLength(1);
  });
});

// ─── 워커 재해석 정책 ───

describe("InterpretationWorker policy", () => {
  const makeMessage = (overrides?: Partial<Message>): Message => ({
    id: "msg-1",
    channel_id: "C1",
    ts: "1000.001",
    thread_ts: null,
    user_id: "U1",
    user_name: "alice",
    avatar_url: null,
    content: "hello",
    attachments: [],
    reactions: [],
    is_bot: false,
    is_deleted: false,
    source_edited: false,
    enrichment_count: 0,
    reply_count: 0,
    latest_interpretation: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  const makeInterpretation = (overrides?: Partial<Interpretation>): Interpretation => ({
    id: "interp-1",
    channel_id: "C1",
    message_id: "msg-1",
    thread_ts: null,
    type: "context",
    content: "summary from content",
    metadata: {
      intent: "질문",
      addressees: [{ id: "U2", name: "bob" }],
      confidence: 0.9,
      adversarial_note: null,
    },
    created_at: "2026-01-01T00:01:00.000Z",
    ...overrides,
  });

  it("기본 confidence threshold는 0.75다", () => {
    expect(DEFAULT_CONFIDENCE_THRESHOLD).toBe(0.75);
  });

  it("confidence가 0.75 미만이면 low_confidence로 재해석 대상이 된다", () => {
    const status = getInterpretationStatus(
      makeMessage(),
      makeInterpretation({ metadata: { intent: "질문", addressees: [], confidence: 0.74 } }),
      DEFAULT_CONFIDENCE_THRESHOLD,
    );
    expect(status.status).toBe("low_confidence");
  });

  it("message updated_at이 interpretation created_at보다 늦으면 stale로 재해석 대상이 된다", () => {
    const status = getInterpretationStatus(
      makeMessage({ updated_at: "2026-01-01T00:02:00.000Z" }),
      makeInterpretation({ created_at: "2026-01-01T00:01:00.000Z" }),
      DEFAULT_CONFIDENCE_THRESHOLD,
    );
    expect(status.status).toBe("stale");
  });

  it("metadata가 해석 필드를 담지 못하면 invalid_metadata로 재해석 대상이 된다", () => {
    const status = getInterpretationStatus(
      makeMessage(),
      makeInterpretation({ metadata: { confidence: "높음" } }),
      DEFAULT_CONFIDENCE_THRESHOLD,
    );
    expect(status.status).toBe("invalid_metadata");
  });

  it("ready 상태는 summary를 interpretation.content에서 읽는다", () => {
    const status = getInterpretationStatus(
      makeMessage(),
      makeInterpretation({
        content: "content summary wins",
        metadata: {
          summary: "wrong metadata summary",
          intent: "질문",
          addressees: [],
          confidence: 0.9,
        },
      }),
      DEFAULT_CONFIDENCE_THRESHOLD,
    );
    expect(status.status).toBe("ready");
    expect(status.summary).toBe("content summary wins");
  });

  it("getEnabledChannels는 interpretation_enabled=true 채널만 조회한다", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "C1", name: "enabled" }] });
    const worker = new InterpretationWorker(
      { query } as any,
      {} as any,
      {} as any,
      {
        soulstreamBaseUrl: "http://localhost:1",
        soulstreamAuthToken: "test",
      },
    );

    const rows = await (worker as any).getEnabledChannels();

    expect(rows).toEqual([{ id: "C1", name: "enabled" }]);
    expect(query.mock.calls[0][0]).toContain("interpretation_enabled = true");
  });

  it("processChannel은 유효한 window_context를 기존 interpretations 테이블에 저장한다", async () => {
    const messages = [
      makeMessage({ id: "msg-1", ts: "1000.001", content: "첫 메시지" }),
      makeMessage({ id: "msg-2", ts: "1000.002", content: "둘째 메시지" }),
    ];
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [...messages].reverse() })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const store = vi.fn().mockResolvedValue({});
    const worker = new InterpretationWorker(
      { query } as any,
      { store } as any,
      {} as any,
      {
        soulstreamBaseUrl: "http://localhost:1",
        soulstreamAuthToken: "test",
        targetWindow: 2,
        priorWindow: 0,
        idleIntervalMs: 0,
      },
    );
    (worker as any).soulstream = {
      run: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          window_context: {
            summary: "두 메시지는 배포 순서 확인 흐름이다",
            candidate_angles: ["배포 순서를 짚는다"],
            open_loops: ["prompt row 갱신 여부"],
            avoid_repetition_notes: ["이미 언급한 lookup 설명 반복 금지"],
            participants_focus: ["alice가 확인을 요청함"],
            confidence: 0.84,
          },
          interpretations: [
            {
              message_id: "msg-1",
              addressees: [],
              intent: "상황 공유",
              summary: "첫 메시지",
              confidence: 0.9,
              adversarial_note: null,
            },
            {
              message_id: "msg-2",
              addressees: [],
              intent: "요청",
              summary: "둘째 메시지",
              confidence: 0.88,
              adversarial_note: null,
            },
          ],
        }),
      }),
    };

    const didWork = await (worker as any).processChannel("C1", "general");

    expect(didWork).toBe(true);
    expect(store).toHaveBeenCalledWith(expect.objectContaining({
      channel_id: "C1",
      type: "window_context",
      content: "두 메시지는 배포 순서 확인 흐름이다",
      metadata: expect.objectContaining({
        schema_version: 1,
        confidence: 0.84,
        from_ts: "1000.001",
        to_ts: "1000.002",
        message_ids: ["msg-1", "msg-2"],
        target_message_ids: ["msg-1", "msg-2"],
      }),
    }));
  });
});
