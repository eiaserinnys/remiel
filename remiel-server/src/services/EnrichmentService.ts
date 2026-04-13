import pg from "pg";
import type { EnrichmentStatus, EnrichmentQueueItem } from "../types/index.js";
import * as enrichmentQueries from "../db/queries/enrichment.js";

export class EnrichmentService {
  constructor(private pool: pg.Pool) {}

  async enqueue(messageId: string, type: "link_crawl" | "attachment", target: string): Promise<void> {
    return enrichmentQueries.enqueue(this.pool, messageId, type, target);
  }

  async getStatus(): Promise<EnrichmentStatus> {
    return enrichmentQueries.getStatus(this.pool);
  }

  async retry(id: string): Promise<EnrichmentQueueItem | null> {
    return enrichmentQueries.retryItem(this.pool, id);
  }
}
