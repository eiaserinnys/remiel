import pg from "pg";
import type {
  Message,
  StoreMessageInput,
  MessageUpdate,
  GetMessagesOptions,
  MessagesPage,
  Reaction,
} from "../../types/index.js";

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

/**
 * `ts:id` 형식의 커서를 파싱한다.
 *
 * 잘못된 포맷(빈 문자열, 콜론 없음, 파트가 비어있음)은 `null`을 반환하여
 * 호출부에서 조용히 `latest` 모드로 폴백할 수 있게 한다.
 */
function parseCursor(cursor: string | undefined): { ts: string; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.indexOf(":");
  if (idx <= 0 || idx === cursor.length - 1) return null;
  const ts = cursor.slice(0, idx);
  const id = cursor.slice(idx + 1);
  if (!ts || !id) return null;
  return { ts, id };
}

/**
 * 채널 메시지를 커서 기반 페이지네이션으로 조회한다.
 *
 * 모드 우선순위(상호 배타적):
 * 1. `before` (과거 방향) — 커서 이전 메시지를 최신순 LIMIT N+1 조회 후 ASC로 반환.
 * 2. `after`  (미래 방향) — 커서 이후 메시지를 오래된순 LIMIT N+1 조회 후 ASC로 반환.
 * 3. `from_to` — `from`/`to` 범위 내 메시지를 ASC로 반환. 페이지네이션 비활성.
 * 4. `latest` — 가장 최신 N개를 ASC로 반환 (초기 진입용).
 *
 * `ts`는 Slack 포맷(`epoch_seconds.microseconds`)으로, 사전식 비교가 시간 비교와 일치한다.
 * `(ts, id)` 튜플 비교로 동일 `ts`에서도 안정적인 순서를 보장한다.
 *
 * `LIMIT N+1` 트릭으로 `hasMore*` 플래그를 추가 쿼리 없이 계산한다.
 */
export async function getMessages(
  pool: pg.Pool,
  channelId: string,
  opts: GetMessagesOptions = {},
): Promise<MessagesPage> {
  // limit 1~100 clamp, 기본 50
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));

  const beforeCursor = parseCursor(opts.before);
  const afterCursor = parseCursor(opts.after);

  // 모드 결정: before/after > from_to > latest
  let mode: "before" | "after" | "from_to" | "latest";
  if (beforeCursor) mode = "before";
  else if (afterCursor) mode = "after";
  else if (opts.from || opts.to) mode = "from_to";
  else mode = "latest";

  const conditions = ["channel_id = $1", "is_deleted = false", "thread_ts IS NULL"];
  const params: unknown[] = [channelId];
  let paramIdx = 2;

  if (mode === "before" && beforeCursor) {
    // 커서 이전(과거): (ts, id) < (cursorTs, cursorId), 최신순 LIMIT N+1
    conditions.push(`(ts, id) < ($${paramIdx++}, $${paramIdx++})`);
    params.push(beforeCursor.ts, beforeCursor.id);
  } else if (mode === "after" && afterCursor) {
    // 커서 이후(미래): (ts, id) > (cursorTs, cursorId), 오래된순 LIMIT N+1
    conditions.push(`(ts, id) > ($${paramIdx++}, $${paramIdx++})`);
    params.push(afterCursor.ts, afterCursor.id);
  } else if (mode === "from_to") {
    if (opts.from) {
      conditions.push(`ts >= $${paramIdx++}`);
      params.push(opts.from);
    }
    if (opts.to) {
      conditions.push(`ts <= $${paramIdx++}`);
      params.push(opts.to);
    }
  }

  // ORDER BY: before/latest는 최신순(DESC)으로 가져와서 마지막에 ASC로 reverse.
  // after/from_to는 오래된순(ASC)으로 직접 가져온다.
  const orderBy =
    mode === "before" || mode === "latest"
      ? "ORDER BY ts DESC, id DESC"
      : "ORDER BY ts ASC, id ASC";

  // LIMIT N+1로 hasMore 판정
  params.push(limit + 1);

  const { rows } = await pool.query<Message>(
    `SELECT m.*,
       (SELECT COUNT(*)::int FROM enrichment_queue eq WHERE eq.message_id = m.id) AS enrichment_count
     FROM messages m
     WHERE ${conditions.join(" AND ")} ${orderBy} LIMIT $${paramIdx}`,
    params,
  );

  // N+1 초과분 잘라내기
  const hasMoreThisDirection = rows.length > limit;
  const page = hasMoreThisDirection ? rows.slice(0, limit) : rows;

  // 항상 ASC 순서로 반환 (before/latest는 DESC로 쿼리했으므로 reverse)
  const messages = mode === "before" || mode === "latest" ? page.reverse() : page;

  // 커서와 hasMore 계산
  let hasMoreOlder = false;
  let hasMoreNewer = false;
  if (mode === "before") {
    hasMoreOlder = hasMoreThisDirection;
    hasMoreNewer = true; // 커서 이전을 조회했으므로 커서 이후에는 최소한 커서 자신이 존재
  } else if (mode === "after") {
    hasMoreNewer = hasMoreThisDirection;
    hasMoreOlder = true; // 커서 이후를 조회했으므로 커서 이전에는 최소한 커서 자신이 존재
  } else if (mode === "latest") {
    hasMoreOlder = hasMoreThisDirection;
    hasMoreNewer = false; // 최신 페이지이므로 더 새로운 것은 없음
  }
  // from_to 모드는 hasMoreOlder/Newer 모두 false (범위 조회이므로 페이지네이션 비활성)

  const oldest = messages[0];
  const newest = messages[messages.length - 1];
  const oldestCursor = oldest ? `${oldest.ts}:${oldest.id}` : null;
  const newestCursor = newest ? `${newest.ts}:${newest.id}` : null;

  return { messages, oldestCursor, newestCursor, hasMoreOlder, hasMoreNewer };
}

export async function getThread(pool: pg.Pool, channelId: string, threadTs: string): Promise<Message[]> {
  const { rows } = await pool.query<Message>(
    `SELECT m.*,
       (SELECT COUNT(*)::int FROM enrichment_queue eq WHERE eq.message_id = m.id) AS enrichment_count
     FROM messages m
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
