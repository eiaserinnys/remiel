import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageService } from "../src/services/MessageService.js";
import { InterpretationService } from "../src/services/InterpretationService.js";
import { EnrichmentService } from "../src/services/EnrichmentService.js";
import { EventBus } from "../src/shared/EventBus.js";
import type { RemielEvent } from "../src/shared/EventBus.js";
import type pg from "pg";

function createMockPool(queryFn: (...args: unknown[]) => unknown): pg.Pool {
  return { query: queryFn } as unknown as pg.Pool;
}

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

describe("MessageService event emission", () => {
  let eventBus: EventBus;
  let events: RemielEvent[];

  beforeEach(() => {
    eventBus = new EventBus();
    events = [];
    eventBus.subscribe((e) => events.push(e));
  });

  it("emits message:created when storeMessage succeeds", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [sampleMessage] });
    const service = new MessageService(createMockPool(mockQuery), eventBus);

    await service.storeMessage({
      channel_id: "C123",
      ts: "1234567890.123456",
      user_id: "U001",
      user_name: "testuser",
      content: "hello",
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message:created");
    expect(events[0].data).toEqual(sampleMessage);
  });

  it("emits message:updated when updateMessage succeeds", async () => {
    const updatedMessage = { ...sampleMessage, content: "edited" };
    const mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [sampleMessage] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [updatedMessage] }); // UPDATE RETURNING

    const service = new MessageService(createMockPool(mockQuery), eventBus);

    await service.updateMessage("C123", "1234567890.123456", { content: "edited" });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message:updated");
  });

  it("does not emit events when no eventBus is provided", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [sampleMessage] });
    const service = new MessageService(createMockPool(mockQuery)); // no eventBus

    await service.storeMessage({
      channel_id: "C123",
      ts: "1234567890.123456",
      user_id: "U001",
      user_name: "testuser",
      content: "hello",
    });

    // No crash, no events (no bus to subscribe to)
    expect(events).toHaveLength(0);
  });
});

describe("MessageService auto-enqueue", () => {
  let eventBus: EventBus;
  let enrichmentService: EnrichmentService;
  let enqueueSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    eventBus = new EventBus();
    const enrichmentPool = createMockPool(vi.fn().mockResolvedValue({ rows: [] }));
    enrichmentService = new EnrichmentService(enrichmentPool);
    enqueueSpy = vi.spyOn(enrichmentService, "enqueue").mockResolvedValue(undefined);
  });

  it("auto-enqueues URLs found in message content", async () => {
    const messageWithUrl = {
      ...sampleMessage,
      content: "Check this out: https://example.com/article and also http://test.org/page",
    };
    const mockQuery = vi.fn().mockResolvedValue({ rows: [messageWithUrl] });
    const service = new MessageService(createMockPool(mockQuery), eventBus, enrichmentService);

    await service.storeMessage({
      channel_id: "C123",
      ts: "1234567890.123456",
      user_id: "U001",
      user_name: "testuser",
      content: "Check this out: https://example.com/article and also http://test.org/page",
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSpy).toHaveBeenCalledWith("uuid-1", "link_crawl", "https://example.com/article");
    expect(enqueueSpy).toHaveBeenCalledWith("uuid-1", "link_crawl", "http://test.org/page");
  });

  it("auto-enqueues attachments with url property", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [sampleMessage] });
    const service = new MessageService(createMockPool(mockQuery), eventBus, enrichmentService);

    await service.storeMessage({
      channel_id: "C123",
      ts: "1234567890.123456",
      user_id: "U001",
      user_name: "testuser",
      content: "hello",
      attachments: [{ url: "https://files.slack.com/doc.pdf" }],
    });

    expect(enqueueSpy).toHaveBeenCalledWith("uuid-1", "attachment", "https://files.slack.com/doc.pdf");
  });

  it("does not enqueue when content has no URLs", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [sampleMessage] });
    const service = new MessageService(createMockPool(mockQuery), eventBus, enrichmentService);

    await service.storeMessage({
      channel_id: "C123",
      ts: "1234567890.123456",
      user_id: "U001",
      user_name: "testuser",
      content: "just plain text",
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does not enqueue when no enrichmentService is provided", async () => {
    const messageWithUrl = {
      ...sampleMessage,
      content: "https://example.com",
    };
    const mockQuery = vi.fn().mockResolvedValue({ rows: [messageWithUrl] });
    const service = new MessageService(createMockPool(mockQuery), eventBus); // no enrichmentService

    await service.storeMessage({
      channel_id: "C123",
      ts: "1234567890.123456",
      user_id: "U001",
      user_name: "testuser",
      content: "https://example.com",
    });

    // No crash, no enqueue
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

describe("InterpretationService event emission", () => {
  it("emits interpretation:created when store succeeds", async () => {
    const interp = {
      id: "uuid-i1",
      channel_id: "C123",
      message_id: "uuid-1",
      thread_ts: null,
      type: "summary",
      content: "this is a summary",
      metadata: {},
      created_at: "now",
    };

    const eventBus = new EventBus();
    const events: RemielEvent[] = [];
    eventBus.subscribe((e) => events.push(e));

    const mockQuery = vi.fn().mockResolvedValue({ rows: [interp] });
    const service = new InterpretationService(createMockPool(mockQuery), eventBus);

    await service.store({ channel_id: "C123", message_id: "uuid-1", content: "this is a summary" });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("interpretation:created");
    expect(events[0].data).toEqual(interp);
  });
});
