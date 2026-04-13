import pg from "pg";
import type { Interpretation, StoreInterpretationInput } from "../types/index.js";
import * as interpretationQueries from "../db/queries/interpretations.js";

export class InterpretationService {
  constructor(private pool: pg.Pool) {}

  async store(input: StoreInterpretationInput): Promise<Interpretation> {
    return interpretationQueries.storeInterpretation(this.pool, input);
  }

  async getByMessage(messageId: string): Promise<Interpretation[]> {
    return interpretationQueries.getByMessage(this.pool, messageId);
  }

  async getByThread(channelId: string, threadTs: string): Promise<Interpretation[]> {
    return interpretationQueries.getByThread(this.pool, channelId, threadTs);
  }
}
