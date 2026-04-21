import pg from "pg";
import type { InterpretationPrompt } from "../../types/index.js";
import { DEFAULT_INTERPRETATION_PROMPT } from "../../worker/buildPrompt.js";

export async function getPrompt(
  pool: pg.Pool,
  key: string,
): Promise<InterpretationPrompt | null> {
  const { rows } = await pool.query<InterpretationPrompt>(
    "SELECT * FROM interpretation_prompts WHERE key = $1",
    [key],
  );
  return rows[0] ?? null;
}

export async function updatePrompt(
  pool: pg.Pool,
  key: string,
  content: string,
): Promise<InterpretationPrompt> {
  const { rows } = await pool.query<InterpretationPrompt>(
    `INSERT INTO interpretation_prompts (key, content)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, updated_at = now()
     RETURNING *`,
    [key, content],
  );
  return rows[0];
}

export async function listPrompts(
  pool: pg.Pool,
): Promise<InterpretationPrompt[]> {
  const { rows } = await pool.query<InterpretationPrompt>(
    "SELECT * FROM interpretation_prompts ORDER BY key",
  );
  return rows;
}

/**
 * 기본 해석 프롬프트를 seed한다. 이미 존재하면 무시.
 */
export async function seedDefaultPrompt(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO interpretation_prompts (key, content)
     VALUES ('context_interpretation', $1)
     ON CONFLICT (key) DO NOTHING`,
    [DEFAULT_INTERPRETATION_PROMPT],
  );
}
