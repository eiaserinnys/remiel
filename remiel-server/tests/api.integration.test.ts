import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createServer } from "../src/api/server.js";
import { registerRoutes } from "../src/api/routes.js";
import { MessageService } from "../src/services/MessageService.js";
import { ChannelService } from "../src/services/ChannelService.js";
import { InterpretationService } from "../src/services/InterpretationService.js";
import { EnrichmentService } from "../src/services/EnrichmentService.js";
import { EventBus } from "../src/shared/EventBus.js";
import { migrate } from "../src/db/migrate.js";
import type { FastifyInstance } from "fastify";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://remiel:remiel@localhost:5434/remiel_test_db";

// Guard: refuse to run against production
if (!TEST_DATABASE_URL.includes("test")) {
  throw new Error("TEST_DATABASE_URL must use a test database. Current value does not contain 'test'.");
}

let pool: pg.Pool;
let app: FastifyInstance;
let eventBus: EventBus;

const API_KEY = "test-api-key-12345";

beforeAll(async () => {
  process.env.API_KEY = API_KEY;
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

  await migrate(pool);

  eventBus = new EventBus();
  const enrichmentService = new EnrichmentService(pool);
  const messageService = new MessageService(pool, eventBus, enrichmentService);
  const channelService = new ChannelService(pool);
  const interpretationService = new InterpretationService(pool, eventBus);

  app = await createServer();
  registerRoutes(app, { messageService, channelService, interpretationService, enrichmentService, eventBus });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // Clean up test data
  await pool.query("DELETE FROM interpretations");
  await pool.query("DELETE FROM enrichment_queue");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM channels");
  await pool.end();
});

beforeEach(async () => {
  // Clean tables before each test
  await pool.query("DELETE FROM interpretations");
  await pool.query("DELETE FROM enrichment_queue");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM channels");
});

function inject(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = { "x-api-key": API_KEY };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return app.inject({
    method: method as "GET" | "POST" | "PATCH" | "DELETE",
    url,
    headers,
    payload: body ? JSON.stringify(body) : undefined,
  });
}

describe("Health endpoint", () => {
  it("GET /api/health returns 200 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("ok");
  });
});

describe("Auth", () => {
  it("allows GET requests without API key in local dev mode", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/channels",
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("Channel CRUD", () => {
  it("POST /api/channels registers a channel", async () => {
    const res = await inject("POST", "/api/channels", { id: "C100", name: "test-channel" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.id).toBe("C100");
    expect(body.name).toBe("test-channel");
    expect(body.source).toBe("slack");
  });

  it("GET /api/channels lists channels", async () => {
    await inject("POST", "/api/channels", { id: "C200", name: "chan-a" });
    await inject("POST", "/api/channels", { id: "C201", name: "chan-b" });

    const res = await inject("GET", "/api/channels");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveLength(2);
  });
});

describe("Message CRUD", () => {
  beforeEach(async () => {
    await inject("POST", "/api/channels", { id: "C300", name: "msg-test" });
  });

  it("POST /api/messages stores a message", async () => {
    const res = await inject("POST", "/api/messages", {
      channel_id: "C300",
      ts: "1000.001",
      user_id: "U001",
      user_name: "alice",
      content: "hello world",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.content).toBe("hello world");
    expect(body.id).toBeDefined();
  });

  it("POST /api/messages/batch stores multiple messages", async () => {
    const res = await inject("POST", "/api/messages/batch", {
      messages: [
        { channel_id: "C300", ts: "2000.001", user_id: "U001", user_name: "alice", content: "msg1" },
        { channel_id: "C300", ts: "2000.002", user_id: "U002", user_name: "bob", content: "msg2" },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveLength(2);
  });

  it("PATCH /api/messages/:channelId/:ts updates content", async () => {
    await inject("POST", "/api/messages", {
      channel_id: "C300",
      ts: "3000.001",
      user_id: "U001",
      user_name: "alice",
      content: "original",
    });

    const res = await inject("PATCH", "/api/messages/C300/3000.001", {
      content: "edited",
      source_edited: true,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.content).toBe("edited");
    expect(body.source_edited).toBe(true);
  });

  it("PATCH /api/messages/:channelId/:ts adds a reaction", async () => {
    await inject("POST", "/api/messages", {
      channel_id: "C300",
      ts: "4000.001",
      user_id: "U001",
      user_name: "alice",
      content: "react me",
    });

    const res = await inject("PATCH", "/api/messages/C300/4000.001", {
      reaction_add: { emoji: "thumbsup", user: "U002" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const reactions = body.reactions;
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe("thumbsup");
    expect(reactions[0].users).toContain("U002");
  });

  it("PATCH /api/messages/:channelId/:ts removes a reaction", async () => {
    await inject("POST", "/api/messages", {
      channel_id: "C300",
      ts: "5000.001",
      user_id: "U001",
      user_name: "alice",
      content: "unreact me",
      reactions: [{ emoji: "heart", users: ["U002", "U003"] }],
    });

    const res = await inject("PATCH", "/api/messages/C300/5000.001", {
      reaction_remove: { emoji: "heart", user: "U002" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.reactions).toHaveLength(1);
    expect(body.reactions[0].users).toEqual(["U003"]);
  });

  it("DELETE /api/messages/:channelId/:ts soft-deletes a message", async () => {
    await inject("POST", "/api/messages", {
      channel_id: "C300",
      ts: "6000.001",
      user_id: "U001",
      user_name: "alice",
      content: "delete me",
    });

    const delRes = await inject("DELETE", "/api/messages/C300/6000.001");
    expect(delRes.statusCode).toBe(204);

    // Verify it's gone from normal listing
    const listRes = await inject("GET", "/api/channels/C300/messages");
    const page = JSON.parse(listRes.payload);
    const deleted = page.messages.find((m: { ts: string }) => m.ts === "6000.001");
    expect(deleted).toBeUndefined();
  });

  it("GET /api/channels/:channelId/messages returns a page of messages", async () => {
    await inject("POST", "/api/messages", {
      channel_id: "C300",
      ts: "7000.001",
      user_id: "U001",
      user_name: "alice",
      content: "msg1",
    });
    await inject("POST", "/api/messages", {
      channel_id: "C300",
      ts: "7000.002",
      user_id: "U002",
      user_name: "bob",
      content: "msg2",
    });

    const res = await inject("GET", "/api/channels/C300/messages?limit=10");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.messages).toHaveLength(2);
    // ASC 정렬 보장
    expect(body.messages[0].ts).toBe("7000.001");
    expect(body.messages[1].ts).toBe("7000.002");
    // latest 모드: hasMoreNewer는 false, hasMoreOlder도 2 < 10이므로 false
    expect(body.hasMoreNewer).toBe(false);
    expect(body.hasMoreOlder).toBe(false);
    expect(body.oldestCursor).toMatch(/^7000\.001:/);
    expect(body.newestCursor).toMatch(/^7000\.002:/);
  });

  it("GET /api/channels/:channelId/messages with `before` cursor returns older messages", async () => {
    // Seed 5 messages, then page backward with limit=2
    for (let i = 1; i <= 5; i++) {
      await inject("POST", "/api/messages", {
        channel_id: "C300",
        ts: `7100.00${i}`,
        user_id: "U001",
        user_name: "alice",
        content: `msg${i}`,
      });
    }

    // latest 2 messages (msg4, msg5)
    const firstRes = await inject("GET", "/api/channels/C300/messages?limit=2");
    const first = JSON.parse(firstRes.payload);
    expect(first.messages).toHaveLength(2);
    expect(first.messages[0].ts).toBe("7100.004");
    expect(first.messages[1].ts).toBe("7100.005");
    expect(first.hasMoreOlder).toBe(true);
    expect(first.hasMoreNewer).toBe(false);

    // Page older using before=oldestCursor → should return msg2, msg3
    const secondRes = await inject(
      "GET",
      `/api/channels/C300/messages?limit=2&before=${encodeURIComponent(first.oldestCursor!)}`,
    );
    const second = JSON.parse(secondRes.payload);
    expect(second.messages).toHaveLength(2);
    expect(second.messages[0].ts).toBe("7100.002");
    expect(second.messages[1].ts).toBe("7100.003");
    expect(second.hasMoreOlder).toBe(true); // msg1 still left
    expect(second.hasMoreNewer).toBe(true); // before 모드이므로 항상 true

    // One more page → msg1 only
    const thirdRes = await inject(
      "GET",
      `/api/channels/C300/messages?limit=2&before=${encodeURIComponent(second.oldestCursor!)}`,
    );
    const third = JSON.parse(thirdRes.payload);
    expect(third.messages).toHaveLength(1);
    expect(third.messages[0].ts).toBe("7100.001");
    expect(third.hasMoreOlder).toBe(false);
  });

  it("GET /api/channels/:channelId/messages with `after` cursor returns newer messages", async () => {
    for (let i = 1; i <= 4; i++) {
      await inject("POST", "/api/messages", {
        channel_id: "C300",
        ts: `7200.00${i}`,
        user_id: "U001",
        user_name: "alice",
        content: `msg${i}`,
      });
    }

    // Start at the oldest: after=msg1 → msg2, msg3 (limit=2)
    const firstRes = await inject("GET", "/api/channels/C300/messages?limit=2");
    const first = JSON.parse(firstRes.payload);
    // latest page: msg3, msg4
    expect(first.messages[0].ts).toBe("7200.003");

    // afterCursor targeting from the earliest — hand-built "ts:id"
    // We don't have msg1's id directly; fetch it via range query
    const rangeRes = await inject(
      "GET",
      "/api/channels/C300/messages?from=7200.001&to=7200.001&limit=10",
    );
    const rangeBody = JSON.parse(rangeRes.payload);
    const msg1Cursor = `${rangeBody.messages[0].ts}:${rangeBody.messages[0].id}`;

    // after msg1 → msg2, msg3 (limit=2)
    const afterRes = await inject(
      "GET",
      `/api/channels/C300/messages?limit=2&after=${encodeURIComponent(msg1Cursor)}`,
    );
    const afterBody = JSON.parse(afterRes.payload);
    expect(afterBody.messages).toHaveLength(2);
    expect(afterBody.messages[0].ts).toBe("7200.002");
    expect(afterBody.messages[1].ts).toBe("7200.003");
    expect(afterBody.hasMoreNewer).toBe(true); // msg4 still left
    expect(afterBody.hasMoreOlder).toBe(true); // after 모드이므로 항상 true
  });

  it("GET /api/channels/:channelId/messages clamps limit to [1, 100]", async () => {
    // Over-limit request — should still return any available, no crash
    const overRes = await inject("GET", "/api/channels/C300/messages?limit=9999");
    expect(overRes.statusCode).toBe(200);
    const overBody = JSON.parse(overRes.payload);
    expect(Array.isArray(overBody.messages)).toBe(true);
    // Under-limit (0 or negative) treated as 1 minimum
    const underRes = await inject("GET", "/api/channels/C300/messages?limit=0");
    expect(underRes.statusCode).toBe(200);
  });

  it("GET /api/channels/:channelId/messages silently ignores malformed cursor", async () => {
    await inject("POST", "/api/messages", {
      channel_id: "C300",
      ts: "7300.001",
      user_id: "U001",
      user_name: "alice",
      content: "only",
    });

    // Malformed: no colon, empty parts → should fall back to `latest` mode
    const res = await inject(
      "GET",
      "/api/channels/C300/messages?limit=10&before=notacursor",
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.messages.length).toBeGreaterThan(0);
    // latest 모드 동작이므로 hasMoreNewer는 false
    expect(body.hasMoreNewer).toBe(false);
  });

  it("GET /api/channels/:channelId/threads/:threadTs returns thread", async () => {
    // Parent message
    await inject("POST", "/api/messages", {
      channel_id: "C300",
      ts: "8000.001",
      user_id: "U001",
      user_name: "alice",
      content: "parent",
    });
    // Reply
    await inject("POST", "/api/messages", {
      channel_id: "C300",
      ts: "8000.002",
      thread_ts: "8000.001",
      user_id: "U002",
      user_name: "bob",
      content: "reply",
    });

    const res = await inject("GET", "/api/channels/C300/threads/8000.001");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveLength(2);
  });
});

describe("Compile context", () => {
  beforeEach(async () => {
    await inject("POST", "/api/channels", { id: "C400", name: "compile-test" });
  });

  it("GET /api/channels/:channelId/compile returns markdown", async () => {
    await inject("POST", "/api/messages", {
      channel_id: "C400",
      ts: "9000.001",
      user_id: "U001",
      user_name: "alice",
      content: "compiled message",
    });

    const res = await inject("GET", "/api/channels/C400/compile?limit=10");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.markdown).toContain("compiled message");
    expect(body.markdown).toContain("alice");
  });
});

describe("Interpretations", () => {
  let messageId: string;

  beforeEach(async () => {
    await inject("POST", "/api/channels", { id: "C500", name: "interp-test" });
    const msgRes = await inject("POST", "/api/messages", {
      channel_id: "C500",
      ts: "10000.001",
      user_id: "U001",
      user_name: "alice",
      content: "interpret me",
    });
    messageId = JSON.parse(msgRes.payload).id;
  });

  it("POST /api/interpretations stores an interpretation", async () => {
    const res = await inject("POST", "/api/interpretations", {
      channel_id: "C500",
      message_id: messageId,
      content: "this is a summary",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.content).toBe("this is a summary");
    expect(body.type).toBe("summary");
  });

  it("GET /api/messages/:messageId/interpretations returns interpretations", async () => {
    await inject("POST", "/api/interpretations", {
      channel_id: "C500",
      message_id: messageId,
      content: "interp1",
    });

    const res = await inject("GET", `/api/messages/${messageId}/interpretations`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveLength(1);
    expect(body[0].content).toBe("interp1");
  });

  it("GET /api/channels/:channelId/threads/:threadTs/interpretations returns thread interpretations", async () => {
    await inject("POST", "/api/interpretations", {
      channel_id: "C500",
      thread_ts: "10000.001",
      content: "thread interp",
    });

    const res = await inject("GET", "/api/channels/C500/threads/10000.001/interpretations");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveLength(1);
    expect(body[0].content).toBe("thread interp");
  });

  it("POST /api/interpretations/lookup returns ready context from interpretation content", async () => {
    await inject("PATCH", "/api/channels/C500", { interpretation_enabled: true });
    await inject("POST", "/api/interpretations", {
      channel_id: "C500",
      message_id: messageId,
      type: "context",
      content: "content summary wins",
      metadata: {
        summary: "wrong metadata summary",
        intent: "질문",
        addressees: [{ id: "U002", name: "bob" }],
        confidence: 0.9,
        adversarial_note: null,
      },
    });

    const res = await inject("POST", "/api/interpretations/lookup", {
      channel_id: "C500",
      timestamps: ["10000.001"],
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.channel_enabled).toBe(true);
    expect(body.confidence_threshold).toBe(0.75);
    expect(body.coverage.ready).toBe(1);
    expect(body.items[0]).toMatchObject({
      ts: "10000.001",
      message_id: messageId,
      status: "ready",
      summary: "content summary wins",
      intent: "질문",
      confidence: 0.9,
    });
  });

  it("POST /api/interpretations/lookup preserves input order and reports unresolved statuses", async () => {
    await inject("PATCH", "/api/channels/C500", { interpretation_enabled: true });
    const lowRes = await inject("POST", "/api/messages", {
      channel_id: "C500",
      ts: "10000.002",
      user_id: "U002",
      user_name: "bob",
      content: "low confidence",
    });
    const staleRes = await inject("POST", "/api/messages", {
      channel_id: "C500",
      ts: "10000.003",
      user_id: "U003",
      user_name: "charlie",
      content: "stale",
    });
    const invalidRes = await inject("POST", "/api/messages", {
      channel_id: "C500",
      ts: "10000.004",
      user_id: "U004",
      user_name: "dana",
      content: "invalid",
    });

    const lowId = JSON.parse(lowRes.payload).id;
    const staleId = JSON.parse(staleRes.payload).id;
    const invalidId = JSON.parse(invalidRes.payload).id;

    await inject("POST", "/api/interpretations", {
      channel_id: "C500",
      message_id: lowId,
      type: "context",
      content: "low summary",
      metadata: { intent: "잡담", addressees: [], confidence: 0.5 },
    });
    await inject("POST", "/api/interpretations", {
      channel_id: "C500",
      message_id: staleId,
      type: "context",
      content: "stale summary",
      metadata: { intent: "잡담", addressees: [], confidence: 0.9 },
    });
    await pool.query("UPDATE messages SET updated_at = now() + interval '1 minute' WHERE id = $1", [staleId]);
    await inject("POST", "/api/interpretations", {
      channel_id: "C500",
      message_id: invalidId,
      type: "context",
      content: "invalid summary",
      metadata: { intent: "잡담", confidence: "높음" },
    });

    const res = await inject("POST", "/api/interpretations/lookup", {
      channel_id: "C500",
      timestamps: ["10000.004", "10000.999", "10000.002", "10000.003", "10000.001"],
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.items.map((item: { ts: string }) => item.ts)).toEqual([
      "10000.004",
      "10000.999",
      "10000.002",
      "10000.003",
      "10000.001",
    ]);
    expect(body.items.map((item: { status: string }) => item.status)).toEqual([
      "invalid_metadata",
      "missing_message",
      "low_confidence",
      "stale",
      "missing_interpretation",
    ]);
    expect(body.coverage.needs_reasoning).toBe(5);
  });

  it("POST /api/interpretations/lookup marks all items disabled when channel is disabled", async () => {
    const res = await inject("POST", "/api/interpretations/lookup", {
      channel_id: "C500",
      timestamps: ["10000.001", "10000.999"],
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.channel_enabled).toBe(false);
    expect(body.items.map((item: { status: string }) => item.status)).toEqual([
      "disabled_channel",
      "disabled_channel",
    ]);
  });

  it("POST /api/interpretations/lookup rejects confidence_threshold outside 0..1", async () => {
    const res = await inject("POST", "/api/interpretations/lookup", {
      channel_id: "C500",
      timestamps: ["10000.001"],
      confidence_threshold: 1.5,
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/interpretations/lookup rejects missing body with 400", async () => {
    const res = await inject("POST", "/api/interpretations/lookup");
    expect(res.statusCode).toBe(400);
  });
});

describe("Enrichment status", () => {
  it("GET /api/enrichment/status returns empty counts", async () => {
    const res = await inject("GET", "/api/enrichment/status");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({ pending: 0, processing: 0, done: 0, failed: 0 });
  });
});

describe("Auto-enqueue on message store", () => {
  beforeEach(async () => {
    await inject("POST", "/api/channels", { id: "C600", name: "enqueue-test" });
  });

  it("enqueues URL found in message content", async () => {
    await inject("POST", "/api/messages", {
      channel_id: "C600",
      ts: "11000.001",
      user_id: "U001",
      user_name: "alice",
      content: "Check https://example.com/article",
    });

    const statusRes = await inject("GET", "/api/enrichment/status");
    const status = JSON.parse(statusRes.payload);
    expect(status.pending).toBeGreaterThanOrEqual(1);
  });

  it("enqueues attachment with url property", async () => {
    await inject("POST", "/api/messages", {
      channel_id: "C600",
      ts: "11000.002",
      user_id: "U001",
      user_name: "alice",
      content: "see attached",
      attachments: [{ url: "https://files.example.com/doc.pdf" }],
    });

    const statusRes = await inject("GET", "/api/enrichment/status");
    const status = JSON.parse(statusRes.payload);
    expect(status.pending).toBeGreaterThanOrEqual(1);
  });

  it("does not enqueue when no URLs or attachments", async () => {
    // Clear enrichment queue first
    await pool.query("DELETE FROM enrichment_queue");

    await inject("POST", "/api/messages", {
      channel_id: "C600",
      ts: "11000.003",
      user_id: "U001",
      user_name: "alice",
      content: "plain text message",
    });

    const statusRes = await inject("GET", "/api/enrichment/status");
    const status = JSON.parse(statusRes.payload);
    expect(status.pending).toBe(0);
  });
});

describe("Enrichment retry", () => {
  it("POST /api/enrichment/:id/retry resets failed item to pending", async () => {
    await inject("POST", "/api/channels", { id: "C700", name: "retry-test" });
    const msgRes = await inject("POST", "/api/messages", {
      channel_id: "C700",
      ts: "12000.001",
      user_id: "U001",
      user_name: "alice",
      content: "https://retry-test.com",
    });
    const messageId = JSON.parse(msgRes.payload).id;

    // Get the queue item id
    const { rows: queueRows } = await pool.query(
      "SELECT id FROM enrichment_queue WHERE message_id = $1",
      [messageId],
    );
    expect(queueRows.length).toBeGreaterThanOrEqual(1);
    const queueId = queueRows[0].id;

    // Manually set to failed
    await pool.query(
      "UPDATE enrichment_queue SET status = 'failed', error = 'test error' WHERE id = $1",
      [queueId],
    );

    // Retry
    const retryRes = await inject("POST", `/api/enrichment/${queueId}/retry`);
    expect(retryRes.statusCode).toBe(200);
    const retried = JSON.parse(retryRes.payload);
    expect(retried.status).toBe("pending");
    expect(retried.error).toBeNull();
  });

  it("POST /api/enrichment/:id/retry returns 404 for non-failed item", async () => {
    const retryRes = await inject("POST", "/api/enrichment/00000000-0000-0000-0000-000000000000/retry");
    expect(retryRes.statusCode).toBe(404);
  });
});

describe("SSE / EventBus integration", () => {
  it("eventBus receives message:created when storing a message via API", async () => {
    await inject("POST", "/api/channels", { id: "C800", name: "sse-test" });

    const received: unknown[] = [];
    const unsubscribe = eventBus.subscribe((e) => received.push(e));

    await inject("POST", "/api/messages", {
      channel_id: "C800",
      ts: "13000.001",
      user_id: "U001",
      user_name: "alice",
      content: "event test",
    });

    unsubscribe();

    expect(received.length).toBeGreaterThanOrEqual(1);
    const messageCreated = received.find((e: any) => e.type === "message:created");
    expect(messageCreated).toBeDefined();
  });

  it("eventBus receives interpretation:created when storing via API", async () => {
    await inject("POST", "/api/channels", { id: "C801", name: "sse-interp" });
    const msgRes = await inject("POST", "/api/messages", {
      channel_id: "C801",
      ts: "14000.001",
      user_id: "U001",
      user_name: "alice",
      content: "interp event test",
    });
    const messageId = JSON.parse(msgRes.payload).id;

    const received: unknown[] = [];
    const unsubscribe = eventBus.subscribe((e) => received.push(e));

    await inject("POST", "/api/interpretations", {
      channel_id: "C801",
      message_id: messageId,
      content: "test summary",
    });

    unsubscribe();

    const interpCreated = received.find((e: any) => e.type === "interpretation:created");
    expect(interpCreated).toBeDefined();
  });

  it("eventBus receives message:updated when updating via API", async () => {
    await inject("POST", "/api/channels", { id: "C802", name: "sse-update" });
    await inject("POST", "/api/messages", {
      channel_id: "C802",
      ts: "15000.001",
      user_id: "U001",
      user_name: "alice",
      content: "original",
    });

    const received: unknown[] = [];
    const unsubscribe = eventBus.subscribe((e) => received.push(e));

    await inject("PATCH", "/api/messages/C802/15000.001", {
      content: "updated content",
    });

    unsubscribe();

    const messageUpdated = received.find((e: any) => e.type === "message:updated");
    expect(messageUpdated).toBeDefined();
  });
});
