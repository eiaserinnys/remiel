import pg from "pg";
import type { InterpretationPrompt } from "../types/index.js";
import * as promptQueries from "../db/queries/prompts.js";

export class PromptService {
  constructor(private pool: pg.Pool) {}

  async get(key: string): Promise<InterpretationPrompt | null> {
    return promptQueries.getPrompt(this.pool, key);
  }

  async update(key: string, content: string): Promise<InterpretationPrompt> {
    return promptQueries.updatePrompt(this.pool, key, content);
  }

  async list(): Promise<InterpretationPrompt[]> {
    return promptQueries.listPrompts(this.pool);
  }
}
