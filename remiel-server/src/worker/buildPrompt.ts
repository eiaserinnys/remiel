/**
 * 맥락 해석 프롬프트 조립.
 * [이전 5개 + 기존 해석] + [대상 15개 + 기존 해석] = 최대 20개 메시지 윈도우.
 */

import type { Message, Interpretation } from "../types/index.js";

export interface PromptMessage {
  id: string;
  user_id: string;
  user_name: string;
  content: string;
  ts: string;
  is_bot: boolean;
}

export interface MessageWithInterpretation {
  message: PromptMessage;
  existing_interpretation?: {
    summary: string;
    intent: string;
    addressees: string[];
    confidence: number;
  } | null;
}

export interface BuildPromptInput {
  /** 프롬프트 템플릿 (DB에서 로드) */
  promptTemplate: string;
  /** 이전 5개 메시지 (맥락용) */
  priorMessages: MessageWithInterpretation[];
  /** 대상 15개 메시지 (해석 대상) */
  targetMessages: MessageWithInterpretation[];
  /** 채널 이름 */
  channelName: string;
}

/**
 * 메시지 목록을 프롬프트에 삽입할 텍스트로 포맷한다.
 */
function formatMessages(items: MessageWithInterpretation[], section: string): string {
  if (items.length === 0) return "";

  const lines: string[] = [`## ${section}`];
  for (const { message, existing_interpretation } of items) {
    const botTag = message.is_bot ? " [봇]" : "";
    lines.push(`### [${message.ts}] ${message.user_name} (${message.user_id})${botTag}`);
    lines.push(message.content);

    if (existing_interpretation) {
      lines.push(`> 기존 해석: intent="${existing_interpretation.intent}", summary="${existing_interpretation.summary}", addressees=[${existing_interpretation.addressees.join(", ")}], confidence=${existing_interpretation.confidence}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * 해석 대상 메시지 ID 목록을 생성한다.
 */
function formatTargetIds(targets: MessageWithInterpretation[]): string {
  return targets.map((t) => `- ${t.message.id} (${t.message.user_name})`).join("\n");
}

/**
 * 전체 프롬프트를 조립한다.
 * 템플릿의 {{PLACEHOLDER}} 를 실제 값으로 치환한다.
 */
export function buildPrompt(input: BuildPromptInput): string {
  const { promptTemplate, priorMessages, targetMessages, channelName } = input;

  const priorSection = formatMessages(priorMessages, "맥락 (이전 메시지)");
  const targetSection = formatMessages(targetMessages, "해석 대상 메시지");
  const targetIds = formatTargetIds(targetMessages);

  return promptTemplate
    .replace("{{CHANNEL_NAME}}", channelName)
    .replace("{{PRIOR_MESSAGES}}", priorSection)
    .replace("{{TARGET_MESSAGES}}", targetSection)
    .replace("{{TARGET_IDS}}", targetIds)
    .replace("{{TARGET_COUNT}}", String(targetMessages.length));
}

/**
 * Message + Interpretation[]을 MessageWithInterpretation으로 변환한다.
 * 최신 context 해석만 사용한다.
 */
export function toPromptMessage(
  msg: Message,
  interpretations: Interpretation[],
): MessageWithInterpretation {
  const contextInterps = interpretations.filter((i) => i.type === "context");
  const latest = contextInterps[contextInterps.length - 1]; // ASC이므로 마지막이 최신

  let existing_interpretation: MessageWithInterpretation["existing_interpretation"] = null;
  if (latest) {
    const meta = latest.metadata as Record<string, unknown>;
    existing_interpretation = {
      summary: latest.content,
      intent: (meta.intent as string) ?? "",
      addressees: (meta.addressees as string[]) ?? [],
      confidence: (meta.confidence as number) ?? 0,
    };
  }

  return {
    message: {
      id: msg.id,
      user_id: msg.user_id,
      user_name: msg.user_name,
      content: msg.content,
      ts: msg.ts,
      is_bot: msg.is_bot,
    },
    existing_interpretation,
  };
}

/**
 * 근사 토큰 수 계산: Math.ceil(text.length / 4)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 기본 프롬프트 템플릿 (DB가 비어있을 때 seed) */
export const DEFAULT_INTERPRETATION_PROMPT = `당신은 다자간 슬랙 채널 대화를 분석하는 전문 분석가입니다.

채널: {{CHANNEL_NAME}}

아래 대화를 읽고, 해석 대상으로 표시된 각 메시지에 대해 구조화된 해석을 생성하십시오.

{{PRIOR_MESSAGES}}

{{TARGET_MESSAGES}}

## 해석 대상 메시지 ID 목록
{{TARGET_IDS}}

## 지시사항

위 {{TARGET_COUNT}}개 메시지 각각에 대해 다음 필드를 포함하는 JSON 객체를 생성하십시오:

- **message_id**: 메시지 ID (위 목록에서)
- **addressees**: 이 메시지의 수신자(들). user_id 목록. 채널 전체에 말하는 경우 빈 배열.
- **intent**: 발화 의도를 자유 텍스트로. 예시: "질문", "답변", "농담", "정보 공유", "요청", "감사", "동의", "반대", "잡담" 등. 적절한 것이 없으면 자유롭게 생성.
- **summary**: 메시지의 핵심 의미를 1-2문장으로 요약
- **confidence**: 해석 확신도 0.0~1.0

## 적대적 검증

각 해석을 생성한 후, 비평가 관점에서 다음을 점검하십시오:
1. 수신자를 잘못 특정하지 않았는가? (채널 전체 발언을 특정인 지목으로 오해하지 않았는가?)
2. 발화 의도가 피상적이지 않은가? (단순히 "대화"라고 하지 말고 구체적 의도를 포착했는가?)
3. 맥락을 놓치지 않았는가? (이전 메시지의 흐름을 고려했는가?)

검증 결과 문제가 발견되면 해석을 수정하고, **adversarial_note**에 수정 사유를 기록하십시오.
문제가 없으면 adversarial_note는 null로 두십시오.

기존 해석이 있는 메시지의 경우, 기존 해석이 여전히 적절한지도 재검증하십시오.
적절하다면 동일한 해석을 반환하고, 부적절하다면 수정된 해석을 반환하십시오.

## 출력 형식

반드시 아래 JSON 배열만 출력하십시오. 다른 텍스트는 포함하지 마십시오.

\`\`\`json
[
  {
    "message_id": "uuid",
    "addressees": ["user_id1"],
    "intent": "질문",
    "summary": "요약 텍스트",
    "confidence": 0.85,
    "adversarial_note": null
  }
]
\`\`\``;
