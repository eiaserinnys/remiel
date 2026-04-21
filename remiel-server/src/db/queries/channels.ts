import pg from "pg";
import type { Channel, RegisterChannelInput } from "../../types/index.js";

export async function upsertChannel(pool: pg.Pool, input: RegisterChannelInput): Promise<Channel> {
  const { rows } = await pool.query<Channel>(
    `INSERT INTO channels (id, name, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, source = EXCLUDED.source, updated_at = now()
     RETURNING *`,
    [input.id, input.name, input.source ?? "slack"],
  );
  return rows[0];
}

export async function listChannels(pool: pg.Pool): Promise<Channel[]> {
  const { rows } = await pool.query<Channel>("SELECT * FROM channels ORDER BY name");
  return rows;
}

export async function updateChannel(
  pool: pg.Pool,
  id: string,
  updates: { interpretation_enabled?: boolean },
): Promise<Channel> {
  const setClauses: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (updates.interpretation_enabled !== undefined) {
    setClauses.push(`interpretation_enabled = $${paramIdx++}`);
    params.push(updates.interpretation_enabled);
  }

  params.push(id);
  const { rows } = await pool.query<Channel>(
    `UPDATE channels SET ${setClauses.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
    params,
  );
  if (rows.length === 0) throw new Error(`Channel not found: ${id}`);
  return rows[0];
}
