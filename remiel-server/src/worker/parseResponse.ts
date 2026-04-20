/**
 * LLM 응답 파싱 + 변경 감지.
 */

import type { ContextInterpretation } from "../types/index.js";
import type { MessageWithInterpretation } from "./buildPrompt.js";

export interface ParseResult {
  interpretations: ContextInterpretation[];
  raw: string;
}

/**
 * LLM 텍스트 응답에서 JSON 배열을 추출하고 검증한다.
 * ```json ... ``` 코드 블록 또는 베어 JSON 배열을 모두 처리한다.
 */
export function parseResponse(text: string): ParseResult {
  const raw = text;

  // 코드 블록 내의 JSON 추출 시도
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();

  // [ 로 시작하는 부분 추출 (앞뒤 잡다한 텍스트 제거)
  const arrayStart = jsonStr.indexOf("[");
  const arrayEnd = jsonStr.lastIndexOf("]");
  if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
    throw new ParseError("JSON 배열을 찾을 수 없습니다", raw);
  }

  const arrayStr = jsonStr.slice(arrayStart, arrayEnd + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayStr);
  } catch (e) {
    throw new ParseError(`JSON 파싱 실패: ${(e as Error).message}`, raw);
  }

  if (!Array.isArray(parsed)) {
    throw new ParseError("응답이 배열이 아닙니다", raw);
  }

  const interpretations: ContextInterpretation[] = [];
  for (const item of parsed) {
    const validated = validateInterpretation(item);
    if (validated) {
      interpretations.push(validated);
    }
  }

  if (interpretations.length === 0) {
    throw new ParseError("유효한 해석이 없습니다", raw);
  }

  return { interpretations, raw };
}

/**
 * 단일 해석 객체를 검증하고 정규화한다.
 */
function validateInterpretation(item: unknown): ContextInterpretation | null {
  if (!item || typeof item !== "object") return null;

  const obj = item as Record<string, unknown>;

  const message_id = typeof obj.message_id === "string" ? obj.message_id : null;
  if (!message_id) return null;

  const addressees = Array.isArray(obj.addressees)
    ? obj.addressees.filter((a): a is string => typeof a === "string")
    : [];

  const intent = typeof obj.intent === "string" ? obj.intent : "불명";

  const summary = typeof obj.summary === "string" ? obj.summary : "";
  if (!summary) return null;

  const confidence =
    typeof obj.confidence === "number"
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0.5;

  const adversarial_note =
    typeof obj.adversarial_note === "string" ? obj.adversarial_note : null;

  return { message_id, addressees, intent, summary, confidence, adversarial_note };
}

/**
 * 기존 해석과 새 해석을 비교하여 변경 여부를 감지한다.
 * 변경된 메시지만 반환하여 불필요한 DB 쓰기를 방지한다.
 */
export function detectChanges(
  newInterps: ContextInterpretation[],
  existingMap: Map<string, MessageWithInterpretation>,
): ContextInterpretation[] {
  return newInterps.filter((newInterp) => {
    const existing = existingMap.get(newInterp.message_id);
    if (!existing?.existing_interpretation) return true; // 기존 해석 없으면 항상 저장

    const old = existing.existing_interpretation;
    return (
      old.intent !== newInterp.intent ||
      old.summary !== newInterp.summary ||
      old.confidence !== newInterp.confidence ||
      JSON.stringify(old.addressees.sort()) !==
        JSON.stringify(newInterp.addressees.sort())
    );
  });
}

export class ParseError extends Error {
  constructor(
    message: string,
    public raw: string,
  ) {
    super(message);
    this.name = "ParseError";
  }
}
