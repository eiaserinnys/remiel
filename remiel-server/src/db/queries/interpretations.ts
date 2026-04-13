import pg from "pg";
import type { Interpretation, StoreInterpretationInput } from "../../types/index.js";

export async function storeInterpretation(
  pool: pg.Pool,
  input: StoreInterpretationInput,
): Promise<Interpretation> {
  const { rows } = await pool.query<Interpretation>(
    `INSERT INTO interpretations (channel_id, message_id, thread_ts, type, content, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.channel_id,
      input.message_id ?? null,
      input.thread_ts ?? null,
      input.type ?? "summary",
      input.content,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return rows[0];
}

export async function getByMessage(pool: pg.Pool, messageId: string): Promise<Interpretation[]> {
  const { rows } = await pool.query<Interpretation>(
    "SELECT * FROM interpretations WHERE message_id = $1 ORDER BY created_at ASC",
    [messageId],
  );
  return rows;
}

export async function getByThread(
  pool: pg.Pool,
  channelId: string,
  threadTs: string,
): Promise<Interpretation[]> {
  const { rows } = await pool.query<Interpretation>(
    "SELECT * FROM interpretations WHERE channel_id = $1 AND thread_ts = $2 ORDER BY created_at ASC",
    [channelId, threadTs],
  );
  return rows;
}
