import pg from "pg";
import * as cheerio from "cheerio";
import type { EventBus } from "../shared/EventBus.js";
import type { EnrichmentQueueItem, CrawlResult, AttachmentResult } from "../types/index.js";

const USER_AGENT = "Remiel/1.0 (conversation enrichment bot)";
const FETCH_TIMEOUT_MS = 10_000;

export class EnrichmentWorker {
  private running = false;
  private pollIntervalMs: number;

  constructor(
    private pool: pg.Pool,
    private eventBus: EventBus,
    opts?: { pollIntervalMs?: number },
  ) {
    this.pollIntervalMs = opts?.pollIntervalMs ?? 5000;
  }

  async start(): Promise<void> {
    this.running = true;

    // Reset any stale processing items from a previous crash
    await this.pool.query(
      "UPDATE enrichment_queue SET status = 'pending' WHERE status = 'processing'",
    );

    while (this.running) {
      const item = await this.dequeue();
      if (item) {
        await this.process(item);
      } else {
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async dequeue(): Promise<EnrichmentQueueItem | null> {
    const res = await this.pool.query<EnrichmentQueueItem>(
      `UPDATE enrichment_queue
       SET status = 'processing', processed_at = NOW()
       WHERE id = (
         SELECT id FROM enrichment_queue
         WHERE status = 'pending'
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
    );
    return res.rows[0] ?? null;
  }

  private async process(item: EnrichmentQueueItem): Promise<void> {
    try {
      const result =
        item.type === "link_crawl"
          ? await this.crawlLink(item.target)
          : await this.processAttachment(item.target);

      await this.pool.query(
        "UPDATE enrichment_queue SET status = 'done', result = $1, processed_at = NOW() WHERE id = $2",
        [JSON.stringify(result), item.id],
      );

      this.eventBus.emit({
        type: "enrichment:completed",
        data: { id: item.id, messageId: item.message_id, result },
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (item.retry_count + 1 >= item.max_retries) {
        await this.pool.query(
          "UPDATE enrichment_queue SET status = 'failed', error = $1, processed_at = NOW() WHERE id = $2",
          [errorMessage, item.id],
        );
        this.eventBus.emit({
          type: "enrichment:failed",
          data: { id: item.id, messageId: item.message_id, error: errorMessage },
        });
      } else {
        await this.pool.query(
          "UPDATE enrichment_queue SET status = 'pending', retry_count = retry_count + 1, error = $1 WHERE id = $2",
          [errorMessage, item.id],
        );
      }
    }
  }

  async crawlLink(url: string): Promise<CrawlResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: controller.signal,
        redirect: "follow",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      const title =
        $('meta[property="og:title"]').attr("content") ||
        $("title").text().trim() ||
        null;

      const description =
        $('meta[property="og:description"]').attr("content") ||
        $('meta[name="description"]').attr("content") ||
        null;

      const image = $('meta[property="og:image"]').attr("content") || null;

      // Extract body text (first 500 chars, tags stripped)
      $("script, style, nav, footer, header").remove();
      const bodyText = $("body").text().replace(/\s+/g, " ").trim();
      const excerpt = bodyText.length > 500 ? bodyText.slice(0, 500) : bodyText || null;

      return {
        title,
        description,
        image,
        excerpt,
        fetched_at: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async processAttachment(url: string): Promise<AttachmentResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: { "User-Agent": USER_AGENT },
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type");
      const contentLengthStr = response.headers.get("content-length");
      const contentLength = contentLengthStr ? parseInt(contentLengthStr, 10) : null;

      return {
        content_type: contentType,
        content_length: contentLength,
        verified_at: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
