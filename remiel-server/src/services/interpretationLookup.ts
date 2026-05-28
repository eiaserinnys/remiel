import type {
  Addressee,
  Interpretation,
  InterpretationLookupCoverage,
  InterpretationLookupItem,
  Message,
} from "../types/index.js";

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

type MessageForLookup = Pick<Message, "id" | "ts" | "updated_at">;

interface ContextFields {
  summary: string;
  intent: string;
  addressees: Addressee[];
  confidence: number;
  adversarial_note: string | null;
}

export function normalizeConfidenceThreshold(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_CONFIDENCE_THRESHOLD;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("confidence_threshold must be a number between 0 and 1");
  }
  return value;
}

export function getInterpretationStatus(
  message: MessageForLookup,
  interpretation: Interpretation | null | undefined,
  confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
): InterpretationLookupItem {
  if (!interpretation) {
    return {
      ts: message.ts,
      message_id: message.id,
      status: "missing_interpretation",
    };
  }

  const fields = extractContextFields(interpretation);
  if (!fields) {
    return {
      ts: message.ts,
      message_id: message.id,
      status: "invalid_metadata",
      created_at: interpretation.created_at,
    };
  }

  if (isStale(message.updated_at, interpretation.created_at)) {
    return {
      ts: message.ts,
      message_id: message.id,
      status: "stale",
      confidence: fields.confidence,
      threshold: confidenceThreshold,
      created_at: interpretation.created_at,
      updated_at: message.updated_at,
    };
  }

  if (fields.confidence < confidenceThreshold) {
    return {
      ts: message.ts,
      message_id: message.id,
      status: "low_confidence",
      confidence: fields.confidence,
      threshold: confidenceThreshold,
      created_at: interpretation.created_at,
    };
  }

  return {
    ts: message.ts,
    message_id: message.id,
    status: "ready",
    summary: fields.summary,
    intent: fields.intent,
    addressees: fields.addressees,
    confidence: fields.confidence,
    adversarial_note: fields.adversarial_note,
    created_at: interpretation.created_at,
  };
}

export function buildLookupCoverage(items: InterpretationLookupItem[]): InterpretationLookupCoverage {
  const coverage: InterpretationLookupCoverage = {
    requested: items.length,
    ready: 0,
    needs_reasoning: 0,
    disabled_channel: 0,
    missing_message: 0,
    missing_interpretation: 0,
    low_confidence: 0,
    stale: 0,
    invalid_metadata: 0,
  };

  for (const item of items) {
    if (item.status === "ready") {
      coverage.ready += 1;
    } else {
      coverage.needs_reasoning += 1;
      coverage[item.status] += 1;
    }
  }

  return coverage;
}

function extractContextFields(interpretation: Interpretation): ContextFields | null {
  const meta = normalizeMetadata(interpretation.metadata);
  if (!meta) return null;

  const intent = typeof meta.intent === "string" ? meta.intent : null;
  const addressees = normalizeAddressees(meta.addressees);
  const confidence = typeof meta.confidence === "number" && Number.isFinite(meta.confidence)
    ? meta.confidence
    : null;
  const adversarial_note =
    typeof meta.adversarial_note === "string" ? meta.adversarial_note : null;

  if (!intent || addressees === null || confidence === null) return null;
  if (!interpretation.content) return null;

  return {
    summary: interpretation.content,
    intent,
    addressees,
    confidence,
    adversarial_note,
  };
}

function normalizeMetadata(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeAddressees(raw: unknown): Addressee[] | null {
  if (!Array.isArray(raw)) return null;

  const addressees: Addressee[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      addressees.push({ id: item, name: item });
      continue;
    }
    if (item && typeof item === "object" && "id" in item) {
      const obj = item as Record<string, unknown>;
      addressees.push({ id: String(obj.id), name: String(obj.name ?? obj.id) });
      continue;
    }
    return null;
  }
  return addressees;
}

function isStale(messageUpdatedAt: string, interpretationCreatedAt: string): boolean {
  const messageTime = Date.parse(messageUpdatedAt);
  const interpretationTime = Date.parse(interpretationCreatedAt);
  if (!Number.isFinite(messageTime) || !Number.isFinite(interpretationTime)) return false;
  return messageTime > interpretationTime;
}
