import pg from "pg";
import type { Message, StoreMessageInput, MessageUpdate, GetMessagesOptions, Reaction } from "../../types/index.js";

export async function upsertMessage(pool: pg.Pool, input: StoreMessageInput): Promise<Message> {
  const { rows } = await pool.query<Message>(
    `INSERT INTO messages (channel_id, ts, thread_ts, user_id, user_name, avatar_url, content, attachments, reactions, is_bot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (channel_id, ts) DO UPDATE SET
       content = EXCLUDED.content,
       user_name = EXCLUDED.user_name,
       avatar_url = COALESCE(EXCLUDED.avatar_url, messages.avatar_url),
       attachments = EXCLUDED.attachments,
       reactions = EXCLUDED.reactions,
       is_bot = EXCLUDED.is_bot,
       updated_at = now()
     RETURNING *`,
    [
      input.channel_id,
      input.ts,
      input.thread_ts ?? null,
      input.user_id,
      input.user_name,
      input.avatar_url ?? null,
      input.content,
      JSON.stringify(input.attachments ?? []),
      JSON.stringify(input.reactions ?? []),
      input.is_bot ?? false,
    ],
  );
  const msg = rows[0];

  // Backfill avatar_url to all older messages from the same user
  if (msg.avatar_url && msg.user_id) {
    pool.query(
      `UPDATE messages SET avatar_url = $1 WHERE user_id = $2 AND avatar_url IS NULL`,
      [msg.avatar_url, msg.user_id],
    ).catch(() => {});  // fire-and-forget; don't block the insert
  }

  return msg;
}

export async function upsertMessages(pool: pg.Pool, inputs: StoreMessageInput[]): Promise<Message[]> {
  const results: Message[] = [];
  for (const input of inputs) {
    results.push(await upsertMessage(pool, input));
  }
  return results;
}

export async function updateMessage(
  pool: pg.Pool,
  channelId: string,
  ts: string,
  updates: MessageUpdate,
): Promise<Message | null> {
  // First read the existing message
  const { rows: existing } = await pool.query<Message>(
    "SELECT * FROM messages WHERE channel_id = $1 AND ts = $2",
    [channelId, ts],
  );
  if (existing.length === 0) return null;

  const msg = existing[0];
  const setClauses: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (updates.content !== undefined) {
    setClauses.push(`content = $${paramIndex++}`);
    params.push(updates.content);
  }

  if (updates.source_edited !== undefined) {
    setClauses.push(`source_edited = $${paramIndex++}`);
    params.push(updates.source_edited);
  }

  if (updates.attachments !== undefined) {
    setClauses.push(`attachments = $${paramIndex++}`);
    params.push(JSON.stringify(updates.attachments));
  }

  // Handle reaction_add: read-modify-write
  if (updates.reaction_add) {
    const reactions: Reaction[] = Array.isArray(msg.reactions)
      ? (msg.reactions as Reaction[])
      : JSON.parse(msg.reactions as unknown as string);
    const { emoji, user } = updates.reaction_add;
    const existing_reaction = reactions.find((r) => r.emoji === emoji);
    if (existing_reaction) {
      if (!existing_reaction.users.includes(user)) {
        existing_reaction.users.push(user);
      }
    } else {
      reactions.push({ emoji, users: [user] });
    }
    setClauses.push(`reactions = $${paramIndex++}`);
    params.push(JSON.stringify(reactions));
  }

  // Handle reaction_remove: read-modify-write
  if (updates.reaction_remove) {
    // Re-read reactions in case reaction_add modified them above
    let reactions: Reaction[];
    if (updates.reaction_add) {
      // Already handled above, use the last param
      reactions = JSON.parse(params[params.length - 1] as string);
      // Remove the last param since we'll re-add
      params.pop();
      paramIndex--;
      setClauses.pop();
    } else {
      reactions = Array.isArray(msg.reactions)
        ? (msg.reactions as Reaction[])
        : JSON.parse(msg.reactions as unknown as string);
    }
    const { emoji, user } = updates.reaction_remove;
    const reactionIdx = reactions.findIndex((r) => r.emoji === emoji);
    if (reactionIdx !== -1) {
      reactions[reactionIdx].users = reactions[reactionIdx].users.filter((u) => u !== user);
      if (reactions[reactionIdx].users.length === 0) {
        reactions.splice(reactionIdx, 1);
      }
    }
    setClauses.push(`reactions = $${paramIndex++}`);
    params.push(JSON.stringify(reactions));
  }

  params.push(channelId);
  params.push(ts);

  const { rows } = await pool.query<Message>(
    `UPDATE messages SET ${setClauses.join(", ")} WHERE channel_id = $${paramIndex++} AND ts = $${paramIndex++} RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

export async function softDeleteMessage(pool: pg.Pool, channelId: string, ts: string): Promise<void> {
  await pool.query(
    "UPDATE messages SET is_deleted = true, updated_at = now() WHERE channel_id = $1 AND ts = $2",
    [channelId, ts],
  );
}

export async function getMessages(
  pool: pg.Pool,
  channelId: string,
  opts: GetMessagesOptions,
): Promise<Message[]> {
  const conditions = ["channel_id = $1", "is_deleted = false", "thread_ts IS NULL"];
  const params: unknown[] = [channelId];
  let paramIdx = 2;

  if (opts.from) {
    conditions.push(`ts >= $${paramIdx++}`);
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push(`ts <= $${paramIdx++}`);
    params.push(opts.to);
  }

  const limit = opts.limit ?? 100;
  params.push(limit);

  const { rows } = await pool.query<Message>(
    `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY ts ASC LIMIT $${paramIdx}`,
    params,
  );
  return rows;
}

export async function getThread(pool: pg.Pool, channelId: string, threadTs: string): Promise<Message[]> {
  const { rows } = await pool.query<Message>(
    `SELECT * FROM messages
     WHERE channel_id = $1 AND (ts = $2 OR thread_ts = $2) AND is_deleted = false
     ORDER BY ts ASC`,
    [channelId, threadTs],
  );
  return rows;
}

export async function getMessageById(pool: pg.Pool, messageId: string): Promise<Message | null> {
  const { rows } = await pool.query<Message>("SELECT * FROM messages WHERE id = $1", [messageId]);
  return rows[0] ?? null;
}
