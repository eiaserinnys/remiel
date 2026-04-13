import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createServer } from "../src/api/server.js";
import { registerRoutes } from "../src/api/routes.js";
import { MessageService } from "../src/services/MessageService.js";
import { ChannelService } from "../src/services/ChannelService.js";
import { InterpretationService } from "../src/services/InterpretationService.js";
import { EnrichmentService } from "../src/services/EnrichmentService.js";
import { migrate } from "../src/db/migrate.js";
import type { FastifyInstance } from "fastify";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://remiel:remiel@localhost:5434/remiel_test_db";

// Guard: refuse to run against production
if (!TEST_DATABASE_URL.includes("test")) {
  throw new Error("TEST_DATABASE_URL must use a test database. Current value does not contain 'test'.");
}

let pool: pg.Pool;
let app: FastifyInstance;

const API_KEY = "test-api-key-12345";

beforeAll(async () => {
  process.env.API_KEY = API_KEY;
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

  await migrate(pool);

  const messageService = new MessageService(pool);
  const channelService = new ChannelService(pool);
  const interpretationService = new InterpretationService(pool);
  const enrichmentService = new EnrichmentService(pool);

  app = await createServer();
  registerRoutes(app, { messageService, channelService, interpretationService, enrichmentService });
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
  it("rejects requests without API key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/channels",
    });
    expect(res.statusCode).toBe(401);
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
    const msgs = JSON.parse(listRes.payload);
    const deleted = msgs.find((m: { ts: string }) => m.ts === "6000.001");
    expect(deleted).toBeUndefined();
  });

  it("GET /api/channels/:channelId/messages returns messages", async () => {
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
    expect(body).toHaveLength(2);
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
});

describe("Enrichment status", () => {
  it("GET /api/enrichment/status returns empty counts", async () => {
    const res = await inject("GET", "/api/enrichment/status");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({ pending: 0, processing: 0, done: 0, failed: 0 });
  });
});
