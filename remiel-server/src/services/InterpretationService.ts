import pg from "pg";
import type {
  Interpretation,
  InterpretationLookupInput,
  InterpretationLookupResult,
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

    return {
      channel_id: input.channel_id,
      channel_enabled: true,
      confidence_threshold: confidenceThreshold,
      coverage: buildLookupCoverage(items),
      items,
    };
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
