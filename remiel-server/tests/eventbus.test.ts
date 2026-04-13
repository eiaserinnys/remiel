import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/shared/EventBus.js";
import type { RemielEvent } from "../src/shared/EventBus.js";
import type { Message, Interpretation } from "../src/types/index.js";

const sampleMessage: Message = {
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

const sampleInterpretation: Interpretation = {
  id: "uuid-i1",
  channel_id: "C123",
  message_id: "uuid-1",
  thread_ts: null,
  type: "summary",
  content: "test summary",
  metadata: {},
  created_at: "now",
};

describe("EventBus", () => {
  it("delivers message:created events to subscribers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe(handler);

    bus.emit({ type: "message:created", data: sampleMessage });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: "message:created", data: sampleMessage });
  });

  it("delivers message:updated events to subscribers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe(handler);

    bus.emit({ type: "message:updated", data: sampleMessage });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe("message:updated");
  });

  it("delivers enrichment:completed events to subscribers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe(handler);

    bus.emit({
      type: "enrichment:completed",
      data: { id: "eq-1", messageId: "uuid-1", result: { title: "test" } },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe("enrichment:completed");
  });

  it("delivers enrichment:failed events to subscribers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe(handler);

    bus.emit({
      type: "enrichment:failed",
      data: { id: "eq-1", messageId: "uuid-1", error: "timeout" },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe("enrichment:failed");
  });

  it("delivers interpretation:created events to subscribers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe(handler);

    bus.emit({ type: "interpretation:created", data: sampleInterpretation });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe("interpretation:created");
  });

  it("supports multiple subscribers", () => {
    const bus = new EventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.subscribe(handler1);
    bus.subscribe(handler2);

    bus.emit({ type: "message:created", data: sampleMessage });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops delivering events", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe(handler);

    bus.emit({ type: "message:created", data: sampleMessage });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    bus.emit({ type: "message:created", data: sampleMessage });
    expect(handler).toHaveBeenCalledTimes(1); // Still 1, not 2
  });

  it("subscriber receives events of all types", () => {
    const bus = new EventBus();
    const events: RemielEvent[] = [];
    bus.subscribe((e) => events.push(e));

    bus.emit({ type: "message:created", data: sampleMessage });
    bus.emit({ type: "message:updated", data: sampleMessage });
    bus.emit({ type: "enrichment:completed", data: { id: "eq-1", messageId: "uuid-1", result: {} } });
    bus.emit({ type: "enrichment:failed", data: { id: "eq-2", messageId: "uuid-1", error: "err" } });
    bus.emit({ type: "interpretation:created", data: sampleInterpretation });

    expect(events).toHaveLength(5);
    expect(events.map((e) => e.type)).toEqual([
      "message:created",
      "message:updated",
      "enrichment:completed",
      "enrichment:failed",
      "interpretation:created",
    ]);
  });
});
