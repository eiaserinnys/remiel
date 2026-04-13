import type { FastifyInstance } from "fastify";
import type { MessageService } from "../services/MessageService.js";
import type { ChannelService } from "../services/ChannelService.js";
import type { InterpretationService } from "../services/InterpretationService.js";
import type { EnrichmentService } from "../services/EnrichmentService.js";
import type { EventBus } from "../shared/EventBus.js";

export interface Services {
  messageService: MessageService;
  channelService: ChannelService;
  interpretationService: InterpretationService;
  enrichmentService: EnrichmentService;
  eventBus?: EventBus;
}

export function registerRoutes(app: FastifyInstance, services: Services): void {
  const { messageService, channelService, interpretationService, enrichmentService, eventBus } = services;

  // Health
  app.get("/api/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // Channels
  app.post("/api/channels", async (req) => {
    const body = req.body as { id: string; name: string; source?: string };
    return channelService.register(body);
  });

  app.get("/api/channels", async () => {
    return channelService.list();
  });

  // Messages
  app.post("/api/messages", async (req) => {
    const body = req.body as {
      channel_id: string;
      ts: string;
      thread_ts?: string;
      user_id: string;
      user_name: string;
      content: string;
      attachments?: unknown[];
      reactions?: { emoji: string; users: string[] }[];
      is_bot?: boolean;
    };
    return messageService.storeMessage(body);
  });

  app.post("/api/messages/batch", async (req) => {
    const body = req.body as { messages: Parameters<typeof messageService.storeMessage>[0][] };
    return messageService.storeMessages(body.messages);
  });

  app.patch<{
    Params: { channelId: string; ts: string };
  }>("/api/messages/:channelId/:ts", async (req) => {
    const { channelId, ts } = req.params;
    const updates = req.body as {
      content?: string;
      source_edited?: boolean;
      attachments?: unknown[];
      reaction_add?: { emoji: string; user: string };
      reaction_remove?: { emoji: string; user: string };
    };
    return messageService.updateMessage(channelId, ts, updates);
  });

  app.delete<{
    Params: { channelId: string; ts: string };
  }>("/api/messages/:channelId/:ts", async (req, reply) => {
    const { channelId, ts } = req.params;
    await messageService.deleteMessage(channelId, ts);
    reply.code(204).send();
  });

  app.get<{
    Params: { channelId: string };
    Querystring: { from?: string; to?: string; limit?: string };
  }>("/api/channels/:channelId/messages", async (req) => {
    const { channelId } = req.params;
    const { from, to, limit } = req.query;
    return messageService.getMessages(channelId, {
      from,
      to,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  });

  app.get<{
    Params: { channelId: string; threadTs: string };
  }>("/api/channels/:channelId/threads/:threadTs", async (req) => {
    const { channelId, threadTs } = req.params;
    return messageService.getThread(channelId, threadTs);
  });

  app.get<{
    Params: { channelId: string };
    Querystring: { limit?: string; from?: string; to?: string };
  }>("/api/channels/:channelId/compile", async (req) => {
    const { channelId } = req.params;
    const { limit, from, to } = req.query;
    const markdown = await messageService.compileContext(channelId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      from,
      to,
    });
    return { markdown };
  });

  // Interpretations
  app.post("/api/interpretations", async (req) => {
    const body = req.body as {
      channel_id: string;
      message_id?: string;
      thread_ts?: string;
      type?: string;
      content: string;
      metadata?: Record<string, unknown>;
    };
    return interpretationService.store(body);
  });

  app.get<{
    Params: { messageId: string };
  }>("/api/messages/:messageId/interpretations", async (req) => {
    const { messageId } = req.params;
    return interpretationService.getByMessage(messageId);
  });

  app.get<{
    Params: { channelId: string; threadTs: string };
  }>("/api/channels/:channelId/threads/:threadTs/interpretations", async (req) => {
    const { channelId, threadTs } = req.params;
    return interpretationService.getByThread(channelId, threadTs);
  });

  // Enrichment
  app.get("/api/enrichment/status", async () => {
    return enrichmentService.getStatus();
  });

  app.post<{
    Params: { id: string };
  }>("/api/enrichment/:id/retry", async (req, reply) => {
    const { id } = req.params;
    const result = await enrichmentService.retry(id);
    if (!result) {
      reply.code(404).send({ error: "Item not found or not in failed state" });
      return;
    }
    return result;
  });

  // SSE events stream
  if (eventBus) {
    app.get("/events", async (req, reply) => {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Send initial heartbeat
      reply.raw.write(": connected\n\n");

      const unsubscribe = eventBus.subscribe((event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      // Keep connection alive with periodic heartbeats
      const heartbeat = setInterval(() => {
        reply.raw.write(": heartbeat\n\n");
      }, 30_000);

      req.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    });
  }
}
