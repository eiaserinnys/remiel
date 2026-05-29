import pg from "pg";
import type {
  Interpretation,
  InterpretationLookupInput,
  InterpretationLookupResult,
  InterpretationLookupWindowContext,
  Message,
  StoreInterpretationInput,
} from "../types/index.js";
import * as interpretationQueries from "../db/queries/interpretations.js";
import type { EventBus } from "../shared/EventBus.js";
import {
  buildLookupCoverage,
  getInterpretationStatus,
  normalizeConfidenceThreshold,
} from "./interpretationLookup.js";

interface LookupRow {
  id: string;
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  updated_at: string | Date;
  interpretation_id: string | null;
  interpretation_content: string | null;
  interpretation_metadata: Record<string, unknown> | string | null;
  interpretation_created_at: string | Date | null;
}

interface WindowContextRow {
  id: string;
  channel_id: string;
  message_id: string | null;
  thread_ts: string | null;
  type: string;
  content: string;
  metadata: Record<string, unknown> | string | null;
  created_at: string | Date;
}

export class InterpretationService {
  constructor(private pool: pg.Pool, private eventBus?: EventBus) {}

  async store(input: StoreInterpretationInput): Promise<Interpretation> {
    const interpretation = await interpretationQueries.storeInterpretation(this.pool, input);
    this.eventBus?.emit({ type: "interpretation:created", data: interpretation });
    return interpretation;
  }

  async getByMessage(messageId: string): Promise<Interpretation[]> {
    return interpretationQueries.getByMessage(this.pool, messageId);
  }

  async getByThread(channelId: string, threadTs: string): Promise<Interpretation[]> {
    return interpretationQueries.getByThread(this.pool, channelId, threadTs);
  }

  async lookup(input: InterpretationLookupInput): Promise<InterpretationLookupResult> {
    const confidenceThreshold = normalizeConfidenceThreshold(input.confidence_threshold);
    const timestamps = input.timestamps;

    const { rows: channelRows } = await this.pool.query<{ interpretation_enabled: boolean }>(
      "SELECT interpretation_enabled FROM channels WHERE id = $1",
      [input.channel_id],
    );
    const channelEnabled = channelRows[0]?.interpretation_enabled === true;

    if (!channelEnabled) {
      const items = timestamps.map((ts) => ({ ts, status: "disabled_channel" as const }));
      return {
        channel_id: input.channel_id,
        channel_enabled: false,
        confidence_threshold: confidenceThreshold,
        coverage: buildLookupCoverage(items),
        items,
        window_context: null,
      };
    }

    const uniqueTimestamps = [...new Set(timestamps)];
    const { rows } = await this.pool.query<LookupRow>(
      `SELECT
         m.id,
         m.channel_id,
         m.ts,
         m.thread_ts,
         m.updated_at,
         i.id AS interpretation_id,
         i.content AS interpretation_content,
         i.metadata AS interpretation_metadata,
         i.created_at AS interpretation_created_at
       FROM messages m
       LEFT JOIN LATERAL (
         SELECT id, content, metadata, created_at
         FROM interpretations
         WHERE message_id = m.id AND type = 'context'
         ORDER BY created_at DESC
         LIMIT 1
       ) i ON true
       WHERE m.channel_id = $1
         AND m.ts = ANY($2::text[])
         AND m.is_deleted = false`,
      [input.channel_id, uniqueTimestamps],
    );

    const rowsByTs = new Map(rows.map((row) => [row.ts, row]));
    const items = timestamps.map((ts) => {
      const row = rowsByTs.get(ts);
      if (!row) return { ts, status: "missing_message" as const };

      const message = toMessage(row);
      const interpretation = toInterpretation(row);
      return getInterpretationStatus(message, interpretation, confidenceThreshold);
    });
    const windowContext = await this.lookupWindowContext(input.channel_id, timestamps);

    return {
      channel_id: input.channel_id,
      channel_enabled: true,
      confidence_threshold: confidenceThreshold,
      coverage: buildLookupCoverage(items),
      items,
      window_context: windowContext,
    };
  }

  private async lookupWindowContext(
    channelId: string,
    timestamps: string[],
  ): Promise<InterpretationLookupWindowContext | null> {
    const { rows } = await this.pool.query<WindowContextRow>(
      `SELECT id, channel_id, message_id, thread_ts, type, content, metadata, created_at
       FROM interpretations
       WHERE channel_id = $1 AND type = 'window_context'
       ORDER BY created_at DESC
       LIMIT 20`,
      [channelId],
    );

    for (const row of rows) {
      const context = toLookupWindowContext(row, timestamps);
      if (context) return context;
    }
    return null;
  }
}

function toMessage(row: LookupRow): Pick<Message, "id" | "ts" | "updated_at"> {
  return {
    id: row.id,
    ts: row.ts,
    updated_at: toTimestampString(row.updated_at),
  };
}

function toInterpretation(row: LookupRow): Interpretation | null {
  if (!row.interpretation_id || !row.interpretation_content || !row.interpretation_created_at) {
    return null;
  }

  return {
    id: row.interpretation_id,
    channel_id: row.channel_id,
    message_id: row.id,
    thread_ts: row.thread_ts,
    type: "context",
    content: row.interpretation_content,
    metadata: toMetadata(row.interpretation_metadata),
    created_at: toTimestampString(row.interpretation_created_at),
  };
}

function toTimestampString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toMetadata(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toLookupWindowContext(
  row: WindowContextRow,
  timestamps: string[],
): InterpretationLookupWindowContext | null {
  const metadata = toMetadata(row.metadata);
  const fromTs = typeof metadata.from_ts === "string" ? metadata.from_ts : null;
  const toTs = typeof metadata.to_ts === "string" ? metadata.to_ts : null;
  const confidence = typeof metadata.confidence === "number" && Number.isFinite(metadata.confidence)
    ? metadata.confidence
    : null;
  const messageIds = normalizeStringList(metadata.message_ids);
  const targetMessageIds = normalizeStringList(metadata.target_message_ids);

  if (!row.content || !fromTs || !toTs || confidence === null) return null;
  if (messageIds.length === 0 || targetMessageIds.length === 0) return null;
  if (!overlapsRequestedRange(fromTs, toTs, timestamps)) return null;

  return {
    summary: row.content,
    candidate_angles: normalizeStringList(metadata.candidate_angles),
    open_loops: normalizeStringList(metadata.open_loops),
    avoid_repetition_notes: normalizeStringList(metadata.avoid_repetition_notes),
    participants_focus: normalizeStringList(metadata.participants_focus),
    confidence,
    from_ts: fromTs,
    to_ts: toTs,
    message_ids: messageIds,
    target_message_ids: targetMessageIds,
    created_at: toTimestampString(row.created_at),
  };
}

function overlapsRequestedRange(fromTs: string, toTs: string, timestamps: string[]): boolean {
  if (timestamps.length === 0) return true;
  const numericTimestamps = timestamps
    .map((ts) => Number.parseFloat(ts))
    .filter((ts) => Number.isFinite(ts));
  const from = Number.parseFloat(fromTs);
  const to = Number.parseFloat(toTs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || numericTimestamps.length === 0) {
    return false;
  }
  const minTs = Math.min(...numericTimestamps);
  const maxTs = Math.max(...numericTimestamps);
  return to >= minTs && from <= maxTs;
}

function normalizeStringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}
