import pg from "pg";
import type { EnrichmentStatus } from "../../types/index.js";

export async function enqueue(
  pool: pg.Pool,
  messageId: string,
  type: "link_crawl" | "attachment",
  target: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO enrichment_queue (message_id, type, target) VALUES ($1, $2, $3)`,
    [messageId, type, target],
  );
}

export async function getStatus(pool: pg.Pool): Promise<EnrichmentStatus> {
  const { rows } = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text as count FROM enrichment_queue GROUP BY status`,
  );
  const result: EnrichmentStatus = { pending: 0, processing: 0, done: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in result) {
      result[row.status as keyof EnrichmentStatus] = parseInt(row.count, 10);
    }
  }
  return result;
}
