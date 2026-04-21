import { describe, it, expect } from "vitest";
import { parseSSEData } from "../src/worker/SoulstreamClient.js";
import { buildPrompt, estimateTokens, toPromptMessage } from "../src/worker/buildPrompt.js";
import { parseResponse, detectChanges, ParseError } from "../src/worker/parseResponse.js";
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

  it("message_id가 없는 항목은 무시한다", () => {
    const text =
      '[{"addressees":[],"intent":"질문","summary":"test","confidence":0.5},{"message_id":"m2","addressees":[],"intent":"답변","summary":"ok","confidence":0.8}]';

    const { interpretations } = parseResponse(text);
    expect(interpretations).toHaveLength(1);
    expect(interpretations[0].message_id).toBe("m2");
  });

  it("JSON이 없으면 ParseError를 던진다", () => {
    expect(() => parseResponse("no json here")).toThrow(ParseError);
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
