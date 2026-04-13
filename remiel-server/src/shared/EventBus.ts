import { EventEmitter } from "node:events";
import type { Message, Interpretation } from "../types/index.js";

export type RemielEvent =
  | { type: "message:created"; data: Message }
  | { type: "message:updated"; data: Message }
  | { type: "enrichment:completed"; data: { id: string; messageId: string; result: unknown } }
  | { type: "enrichment:failed"; data: { id: string; messageId: string; error: string } }
  | { type: "interpretation:created"; data: Interpretation };

const EVENT_TYPES = [
  "message:created",
  "message:updated",
  "enrichment:completed",
  "enrichment:failed",
  "interpretation:created",
] as const;

export class EventBus {
  private emitter = new EventEmitter();

  emit(event: RemielEvent): void {
    this.emitter.emit(event.type, event);
  }

  subscribe(handler: (event: RemielEvent) => void): () => void {
    for (const t of EVENT_TYPES) {
      this.emitter.on(t, handler);
    }
    return () => {
      for (const t of EVENT_TYPES) {
        this.emitter.off(t, handler);
      }
    };
  }
}
