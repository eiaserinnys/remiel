/**
 * LLM 응답 파싱 + 변경 감지.
 */

import type { ContextInterpretation, Addressee, WindowContext } from "../types/index.js";
import type { MessageWithInterpretation } from "./buildPrompt.js";

export interface ParseResult {
  interpretations: ContextInterpretation[];
  window_context: WindowContext | null;
  raw: string;
}

/**
 * LLM 텍스트 응답에서 JSON을 추출하고 검증한다.
 * ```json ... ``` 코드 블록, 베어 JSON 배열, object payload를 모두 처리한다.
 */
export function parseResponse(text: string): ParseResult {
  const raw = text;

  // 코드 블록 내의 JSON 추출 시도
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();

  const parsed = parseJsonPayload(jsonStr, raw);
  const interpretationItems = Array.isArray(parsed)
    ? parsed
    : extractInterpretationItems(parsed, raw);
  const windowContext = Array.isArray(parsed) ? null : validateWindowContext(
    (parsed as Record<string, unknown>).window_context,
  );

  const interpretations: ContextInterpretation[] = [];
  for (const item of interpretationItems) {
    const validated = validateInterpretation(item);
    if (validated) {
      interpretations.push(validated);
    }
  }

  if (interpretations.length === 0) {
    throw new ParseError("유효한 해석이 없습니다", raw);
  }

  return { interpretations, window_context: windowContext, raw };
}

function parseJsonPayload(jsonStr: string, raw: string): unknown {
  try {
    return JSON.parse(jsonStr);
  } catch {
    const objectStart = jsonStr.indexOf("{");
    const arrayStart = jsonStr.indexOf("[");
    const startsWithObject =
      objectStart !== -1 && (arrayStart === -1 || objectStart < arrayStart);
    const start = startsWithObject ? objectStart : arrayStart;
    const end = startsWithObject ? jsonStr.lastIndexOf("}") : jsonStr.lastIndexOf("]");

    if (start === -1 || end === -1 || end <= start) {
      throw new ParseError("JSON payload를 찾을 수 없습니다", raw);
    }

    const payload = jsonStr.slice(start, end + 1);
    try {
      return JSON.parse(payload);
    } catch (e) {
      throw new ParseError(`JSON 파싱 실패: ${(e as Error).message}`, raw);
    }
  }
}

function extractInterpretationItems(parsed: unknown, raw: string): unknown[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ParseError("응답이 배열 또는 object가 아닙니다", raw);
  }

  const items = (parsed as Record<string, unknown>).interpretations;
  if (!Array.isArray(items)) {
    throw new ParseError("interpretations 배열을 찾을 수 없습니다", raw);
  }
  return items;
}

/**
 * 단일 해석 객체를 검증하고 정규화한다.
 */
function validateInterpretation(item: unknown): ContextInterpretation | null {
  if (!item || typeof item !== "object") return null;

  const obj = item as Record<string, unknown>;

  const message_id = typeof obj.message_id === "string" ? obj.message_id : null;
  if (!message_id) return null;

  const addressees: Addressee[] = Array.isArray(obj.addressees)
    ? obj.addressees
        .map((a): Addressee | null => {
          // 새 포맷: {id, name} 객체
          if (a && typeof a === "object" && "id" in a) {
            return { id: String(a.id), name: String(a.name ?? a.id) };
          }
          // 하위 호환: 문자열(user_id만)
          if (typeof a === "string") return { id: a, name: a };
          return null;
        })
        .filter((a): a is Addressee => a !== null)
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

function validateWindowContext(item: unknown): WindowContext | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const obj = item as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  if (!summary) return null;

  return {
    summary,
    candidate_angles: normalizeStringList(obj.candidate_angles),
    open_loops: normalizeStringList(obj.open_loops),
    avoid_repetition_notes: normalizeStringList(obj.avoid_repetition_notes),
    participants_focus: normalizeStringList(obj.participants_focus),
    confidence: normalizeConfidence(obj.confidence),
  };
}

function normalizeStringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function normalizeConfidence(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.max(0, Math.min(1, raw))
    : 0.5;
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
    const oldIds = old.addressees.map(addresseeId).sort();
    const newIds = newInterp.addressees.map((a) => addresseeId(a as Addressee | string)).sort();
    return (
      old.intent !== newInterp.intent ||
      old.summary !== newInterp.summary ||
      old.confidence !== newInterp.confidence ||
      JSON.stringify(oldIds) !== JSON.stringify(newIds)
    );
  });
}

function addresseeId(addressee: Addressee | string): string {
  return typeof addressee === "string" ? addressee : addressee.id;
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
