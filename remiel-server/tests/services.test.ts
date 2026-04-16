import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageService } from "../src/services/MessageService.js";
import { InterpretationService } from "../src/services/InterpretationService.js";
import { ChannelService } from "../src/services/ChannelService.js";
import { EnrichmentService } from "../src/services/EnrichmentService.js";
import type pg from "pg";

// Mock pg.Pool
function createMockPool(queryFn: (...args: unknown[]) => unknown): pg.Pool {
  return { query: queryFn } as unknown as pg.Pool;
}

describe("ChannelService", () => {
  it("register delegates to upsert query", async () => {
    const channel = { id: "C123", name: "general", source: "slack", created_at: "now", updated_at: "now" };
    const mockQuery = vi.fn().mockResolvedValue({ rows: [channel] });
    const service = new ChannelService(createMockPool(mockQuery));

    const result = await service.register({ id: "C123", name: "general" });
    expect(result).toEqual(channel);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain("INSERT INTO channels");
  });

  it("list returns all channels", async () => {
    const channels = [
      { id: "C1", name: "a", source: "slack", created_at: "now", updated_at: "now" },
      { id: "C2", name: "b", source: "slack", created_at: "now", updated_at: "now" },
    ];
    const mockQuery = vi.fn().mockResolvedValue({ rows: channels });
    const service = new ChannelService(createMockPool(mockQuery));

    const result = await service.list();
    expect(result).toHaveLength(2);
  });
});

describe("MessageService", () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let service: MessageService;

  const sampleMessage = {
    id: "uuid-1",
    channel_id: "C123",
    ts: "1234567890.123456",
    thread_ts: null,
    user_id: "U001",
    user_name: "testuser",
    content: "hello",
    attachments: [],
    reactions: [],
    is_bot: false,
    is_deleted: false,
    source_edited: false,
    created_at: "now",
    updated_at: "now",
  };

  beforeEach(() => {
    mockQuery = vi.fn().mockResolvedValue({ rows: [sampleMessage] });
    service = new MessageService(createMockPool(mockQuery));
  });

  it("storeMessage upserts a single message", async () => {
    const result = await service.storeMessage({
      channel_id: "C123",
      ts: "1234567890.123456",
      user_id: "U001",
      user_name: "testuser",
      content: "hello",
    });
    expect(result.channel_id).toBe("C123");
    expect(mockQuery.mock.calls[0][0]).toContain("ON CONFLICT");
  });

  it("storeMessages calls upsert for each message", async () => {
    const result = await service.storeMessages([
      { channel_id: "C123", ts: "1.0", user_id: "U1", user_name: "a", content: "msg1" },
      { channel_id: "C123", ts: "2.0", user_id: "U2", user_name: "b", content: "msg2" },
    ]);
    expect(result).toHaveLength(2);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("deleteMessage sets is_deleted = true", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await service.deleteMessage("C123", "1.0");
    expect(mockQuery.mock.calls[0][0]).toContain("is_deleted = true");
  });

  it("getMessages queries with channel filter and returns a page", async () => {
    mockQuery.mockResolvedValue({ rows: [sampleMessage] });
    const result = await service.getMessages("C123", { limit: 50 });
    expect(result.messages).toHaveLength(1);
    expect(result.oldestCursor).toBe(`${sampleMessage.ts}:${sampleMessage.id}`);
    expect(result.newestCursor).toBe(`${sampleMessage.ts}:${sampleMessage.id}`);
    expect(result.hasMoreOlder).toBe(false); // 1 row < limit+1, so no more older
    expect(result.hasMoreNewer).toBe(false); // latest mode
    expect(mockQuery.mock.calls[0][0]).toContain("channel_id = $1");
  });

  it("getThread queries by channel and thread_ts", async () => {
    mockQuery.mockResolvedValue({ rows: [sampleMessage] });
    const result = await service.getThread("C123", "1234567890.123456");
    expect(result).toHaveLength(1);
  });

  it("updateMessage throws when message not found", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(service.updateMessage("C123", "nonexistent", { content: "new" }))
      .rejects.toThrow("Message not found");
  });

  it("compileContext returns empty string when no messages", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const result = await service.compileContext("C123", {});
    expect(result).toBe("");
  });

  it("compileContext includes message content in markdown", async () => {
    const messages = [
      {
        ...sampleMessage,
        id: "uuid-1",
        content: "hello world",
        reactions: [],
        is_bot: false,
        thread_ts: null,
      },
    ];
    // First call: getMessages, Second call: getThread (returns same), Third: getByMessage interpretations
    let callIdx = 0;
    const mockQueryFn = vi.fn().mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) return { rows: messages };
      if (callIdx === 2) return { rows: messages }; // getThread returns same msg
      return { rows: [] }; // no interpretations
    });
    const svc = new MessageService(createMockPool(mockQueryFn));
    const result = await svc.compileContext("C123", {});
    expect(result).toContain("hello world");
    expect(result).toContain("testuser");
  });
});

describe("InterpretationService", () => {
  it("store creates an interpretation", async () => {
    const interp = {
      id: "uuid-i1",
      channel_id: "C123",
      message_id: "uuid-m1",
      thread_ts: null,
      type: "summary",
      content: "this is a summary",
      metadata: {},
      created_at: "now",
    };
    const mockQuery = vi.fn().mockResolvedValue({ rows: [interp] });
    const service = new InterpretationService(createMockPool(mockQuery));

    const result = await service.store({ channel_id: "C123", message_id: "uuid-m1", content: "this is a summary" });
    expect(result.content).toBe("this is a summary");
  });

  it("getByMessage returns interpretations for a message", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [{ id: "i1", content: "interp" }] });
    const service = new InterpretationService(createMockPool(mockQuery));

    const result = await service.getByMessage("uuid-m1");
    expect(result).toHaveLength(1);
  });

  it("getByThread returns interpretations for a thread", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const service = new InterpretationService(createMockPool(mockQuery));

    const result = await service.getByThread("C123", "1234.5678");
    expect(result).toHaveLength(0);
  });
});

describe("EnrichmentService", () => {
  it("getStatus returns zero counts when queue is empty", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const service = new EnrichmentService(createMockPool(mockQuery));

    const result = await service.getStatus();
    expect(result).toEqual({ pending: 0, processing: 0, done: 0, failed: 0 });
  });

  it("getStatus aggregates counts by status", async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [
        { status: "pending", count: "3" },
        { status: "done", count: "10" },
      ],
    });
    const service = new EnrichmentService(createMockPool(mockQuery));

    const result = await service.getStatus();
    expect(result).toEqual({ pending: 3, processing: 0, done: 10, failed: 0 });
  });
});
