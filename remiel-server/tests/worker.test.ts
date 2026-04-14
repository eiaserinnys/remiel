import { describe, it, expect, vi, beforeEach } from "vitest";
import { EnrichmentWorker } from "../src/worker/EnrichmentWorker.js";
import { EventBus } from "../src/shared/EventBus.js";
import type { RemielEvent } from "../src/shared/EventBus.js";
import type pg from "pg";

function createMockPool(queryFn: (...args: unknown[]) => unknown): pg.Pool {
  return { query: queryFn } as unknown as pg.Pool;
}

/** Default return for additional dequeue calls beyond the mocked sequence */
const EMPTY_ROWS = { rows: [] };

/**
 * Creates a mock query function that returns specific values for the first N calls
 * and falls back to EMPTY_ROWS for any subsequent calls.
 */
function mockQuerySequence(...values: Array<{ rows: unknown[] }>) {
  const fn = vi.fn().mockResolvedValue(EMPTY_ROWS);
  for (const val of values) {
    fn.mockResolvedValueOnce(val);
  }
  return fn;
}

describe("EnrichmentWorker", () => {
  let eventBus: EventBus;
  let events: RemielEvent[];

  beforeEach(() => {
    eventBus = new EventBus();
    events = [];
    eventBus.subscribe((e) => events.push(e));
  });

  it("resets stale processing items on start", async () => {
    const queryFn = mockQuerySequence(EMPTY_ROWS);

    const pool = createMockPool(queryFn);
    const worker = new EnrichmentWorker(pool, eventBus, { pollIntervalMs: 10 });

    const startPromise = worker.start();
    await new Promise((r) => setTimeout(r, 30));
    worker.stop();
    await startPromise;

    expect(queryFn.mock.calls[0][0]).toContain("SET status = 'pending' WHERE status = 'processing'");
  });

  it("processes a link_crawl item successfully", async () => {
    const queueItem = {
      id: "eq-1",
      message_id: "msg-1",
      type: "link_crawl",
      target: "https://example.com",
      status: "processing",
      result: null,
      error: null,
      retry_count: 0,
      max_retries: 3,
      processed_at: null,
      created_at: "now",
      updated_at: "now",
    };

    const queryFn = mockQuerySequence(
      EMPTY_ROWS,            // reset processing
      { rows: [queueItem] }, // dequeue
      EMPTY_ROWS,            // update done
    );

    const pool = createMockPool(queryFn);
    const worker = new EnrichmentWorker(pool, eventBus, { pollIntervalMs: 10 });

    vi.spyOn(worker, "crawlLink").mockResolvedValue({
      title: "Example",
      description: "A test page",
      image: null,
      excerpt: "Hello world",
      fetched_at: "2026-01-01T00:00:00.000Z",
    });

    const startPromise = worker.start();
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    await startPromise;

    const completed = events.find((e) => e.type === "enrichment:completed");
    expect(completed).toBeDefined();
    expect(completed!.data).toEqual({
      id: "eq-1",
      messageId: "msg-1",
      result: {
        title: "Example",
        description: "A test page",
        image: null,
        excerpt: "Hello world",
        fetched_at: "2026-01-01T00:00:00.000Z",
      },
    });

    const updateCall = queryFn.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("SET status = 'done'"),
    );
    expect(updateCall).toBeDefined();
  });

  it("retries on failure when under max_retries", async () => {
    const queueItem = {
      id: "eq-2",
      message_id: "msg-2",
      type: "link_crawl",
      target: "https://broken.com",
      status: "processing",
      result: null,
      error: null,
      retry_count: 0,
      max_retries: 3,
      processed_at: null,
      created_at: "now",
      updated_at: "now",
    };

    const queryFn = mockQuerySequence(
      EMPTY_ROWS,            // reset
      { rows: [queueItem] }, // dequeue
      EMPTY_ROWS,            // update pending (retry)
    );

    const pool = createMockPool(queryFn);
    const worker = new EnrichmentWorker(pool, eventBus, { pollIntervalMs: 10 });

    vi.spyOn(worker, "crawlLink").mockRejectedValue(new Error("Connection refused"));

    const startPromise = worker.start();
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    await startPromise;

    expect(events.filter((e) => e.type === "enrichment:failed")).toHaveLength(0);

    const retryCall = queryFn.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("retry_count = retry_count + 1"),
    );
    expect(retryCall).toBeDefined();
  });

  it("marks as failed after max_retries reached", async () => {
    const queueItem = {
      id: "eq-3",
      message_id: "msg-3",
      type: "link_crawl",
      target: "https://down.com",
      status: "processing",
      result: null,
      error: null,
      retry_count: 2,
      max_retries: 3,
      processed_at: null,
      created_at: "now",
      updated_at: "now",
    };

    const queryFn = mockQuerySequence(
      EMPTY_ROWS,            // reset
      { rows: [queueItem] }, // dequeue
      EMPTY_ROWS,            // update failed
    );

    const pool = createMockPool(queryFn);
    const worker = new EnrichmentWorker(pool, eventBus, { pollIntervalMs: 10 });

    vi.spyOn(worker, "crawlLink").mockRejectedValue(new Error("Server error"));

    const startPromise = worker.start();
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    await startPromise;

    const failed = events.find((e) => e.type === "enrichment:failed");
    expect(failed).toBeDefined();
    expect(failed!.data).toEqual({
      id: "eq-3",
      messageId: "msg-3",
      error: "Server error",
    });

    const failCall = queryFn.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("SET status = 'failed'"),
    );
    expect(failCall).toBeDefined();
  });

  it("processes attachment items", async () => {
    const queueItem = {
      id: "eq-4",
      message_id: "msg-4",
      type: "attachment",
      target: "https://example.com/file.pdf",
      status: "processing",
      result: null,
      error: null,
      retry_count: 0,
      max_retries: 3,
      processed_at: null,
      created_at: "now",
      updated_at: "now",
    };

    const queryFn = mockQuerySequence(
      EMPTY_ROWS,            // reset
      { rows: [queueItem] }, // dequeue
      EMPTY_ROWS,            // update done
    );

    const pool = createMockPool(queryFn);
    const worker = new EnrichmentWorker(pool, eventBus, { pollIntervalMs: 10 });

    vi.spyOn(worker, "processAttachment").mockResolvedValue({
      content_type: "application/pdf",
      content_length: 12345,
      verified_at: "2026-01-01T00:00:00.000Z",
    });

    const startPromise = worker.start();
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    await startPromise;

    const completed = events.find((e) => e.type === "enrichment:completed");
    expect(completed).toBeDefined();
    expect(completed!.data.result).toEqual({
      content_type: "application/pdf",
      content_length: 12345,
      verified_at: "2026-01-01T00:00:00.000Z",
    });
  });

  describe("Slack auth headers", () => {
    it("adds Authorization header for Slack file URLs when token is set", async () => {
      const queueItem = {
        id: "eq-slack-1",
        message_id: "msg-slack-1",
        type: "link_crawl",
        target: "https://files.slack.com/files-pri/T123/download/file.txt",
        status: "processing",
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        processed_at: null,
        created_at: "now",
        updated_at: "now",
      };

      const queryFn = mockQuerySequence(
        EMPTY_ROWS,
        { rows: [queueItem] },
        EMPTY_ROWS,
      );

      const pool = createMockPool(queryFn);
      const worker = new EnrichmentWorker(pool, eventBus, {
        pollIntervalMs: 10,
        slackBotToken: "xoxb-test-token",
      });

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "<html><head><title>Test</title></head><body>Hello</body></html>",
        headers: new Headers(),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const startPromise = worker.start();
      await new Promise((r) => setTimeout(r, 50));
      worker.stop();
      await startPromise;

      const fetchCall = fetchSpy.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("files.slack.com"),
      );
      expect(fetchCall).toBeDefined();
      const headers = fetchCall![1].headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer xoxb-test-token");

      vi.unstubAllGlobals();
    });

    it("does not add Authorization header for non-Slack URLs", async () => {
      const queueItem = {
        id: "eq-noslack-1",
        message_id: "msg-noslack-1",
        type: "link_crawl",
        target: "https://example.com/page",
        status: "processing",
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        processed_at: null,
        created_at: "now",
        updated_at: "now",
      };

      const queryFn = mockQuerySequence(
        EMPTY_ROWS,
        { rows: [queueItem] },
        EMPTY_ROWS,
      );

      const pool = createMockPool(queryFn);
      const worker = new EnrichmentWorker(pool, eventBus, {
        pollIntervalMs: 10,
        slackBotToken: "xoxb-test-token",
      });

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "<html><head><title>Example</title></head><body>Content</body></html>",
        headers: new Headers(),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const startPromise = worker.start();
      await new Promise((r) => setTimeout(r, 50));
      worker.stop();
      await startPromise;

      const fetchCall = fetchSpy.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("example.com"),
      );
      expect(fetchCall).toBeDefined();
      const headers = fetchCall![1].headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it("does not add Authorization header when no token is configured", async () => {
      const queueItem = {
        id: "eq-notoken-1",
        message_id: "msg-notoken-1",
        type: "link_crawl",
        target: "https://files.slack.com/files-pri/T123/download/file.txt",
        status: "processing",
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        processed_at: null,
        created_at: "now",
        updated_at: "now",
      };

      const queryFn = mockQuerySequence(
        EMPTY_ROWS,
        { rows: [queueItem] },
        EMPTY_ROWS,
      );

      const pool = createMockPool(queryFn);
      const worker = new EnrichmentWorker(pool, eventBus, { pollIntervalMs: 10 });

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "<html><head><title>Login</title></head><body>Sign in</body></html>",
        headers: new Headers(),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const startPromise = worker.start();
      await new Promise((r) => setTimeout(r, 50));
      worker.stop();
      await startPromise;

      const fetchCall = fetchSpy.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("files.slack.com"),
      );
      expect(fetchCall).toBeDefined();
      const headers = fetchCall![1].headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it("does not leak token when files.slack.com appears in non-hostname position", async () => {
      const queueItem = {
        id: "eq-trick-1",
        message_id: "msg-trick-1",
        type: "link_crawl",
        target: "https://evil.com/redirect?to=files.slack.com",
        status: "processing",
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        processed_at: null,
        created_at: "now",
        updated_at: "now",
      };

      const queryFn = mockQuerySequence(
        EMPTY_ROWS,
        { rows: [queueItem] },
        EMPTY_ROWS,
      );

      const pool = createMockPool(queryFn);
      const worker = new EnrichmentWorker(pool, eventBus, {
        pollIntervalMs: 10,
        slackBotToken: "xoxb-test-token",
      });

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "<html><head><title>Evil</title></head><body>Trap</body></html>",
        headers: new Headers(),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const startPromise = worker.start();
      await new Promise((r) => setTimeout(r, 50));
      worker.stop();
      await startPromise;

      const fetchCall = fetchSpy.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("evil.com"),
      );
      expect(fetchCall).toBeDefined();
      const headers = fetchCall![1].headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it("adds Authorization header for attachment HEAD requests to Slack", async () => {
      const queueItem = {
        id: "eq-slack-att-1",
        message_id: "msg-slack-att-1",
        type: "attachment",
        target: "https://files.slack.com/files-pri/T123/download/image.png",
        status: "processing",
        result: null,
        error: null,
        retry_count: 0,
        max_retries: 3,
        processed_at: null,
        created_at: "now",
        updated_at: "now",
      };

      const queryFn = mockQuerySequence(
        EMPTY_ROWS,
        { rows: [queueItem] },
        EMPTY_ROWS,
      );

      const pool = createMockPool(queryFn);
      const worker = new EnrichmentWorker(pool, eventBus, {
        pollIntervalMs: 10,
        slackBotToken: "xoxb-test-token",
      });

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({
          "content-type": "image/png",
          "content-length": "54321",
        }),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const startPromise = worker.start();
      await new Promise((r) => setTimeout(r, 50));
      worker.stop();
      await startPromise;

      const fetchCall = fetchSpy.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("files.slack.com"),
      );
      expect(fetchCall).toBeDefined();
      expect(fetchCall![1].method).toBe("HEAD");
      const headers = fetchCall![1].headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer xoxb-test-token");

      vi.unstubAllGlobals();
    });
  });

  it("stop() terminates the polling loop", async () => {
    const queryFn = vi.fn().mockResolvedValue(EMPTY_ROWS);

    const pool = createMockPool(queryFn);
    const worker = new EnrichmentWorker(pool, eventBus, { pollIntervalMs: 10 });

    const startPromise = worker.start();
    await new Promise((r) => setTimeout(r, 30));
    worker.stop();

    await startPromise;
  });
});
