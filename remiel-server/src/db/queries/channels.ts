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
