import pg from "pg";
import type { EnrichmentStatus } from "../types/index.js";
import * as enrichmentQueries from "../db/queries/enrichment.js";

export class EnrichmentService {
  constructor(private pool: pg.Pool) {}

  async enqueue(messageId: string, type: "link_crawl" | "attachment", target: string): Promise<void> {
    return enrichmentQueries.enqueue(this.pool, messageId, type, target);
  }

  async getStatus(): Promise<EnrichmentStatus> {
    return enrichmentQueries.getStatus(this.pool);
  }
}
