import pg from "pg";
import type { Interpretation, StoreInterpretationInput } from "../types/index.js";
import * as interpretationQueries from "../db/queries/interpretations.js";
import type { EventBus } from "../shared/EventBus.js";

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
}
