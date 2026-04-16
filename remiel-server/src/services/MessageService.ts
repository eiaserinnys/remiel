import pg from "pg";
import type { Message, StoreMessageInput, MessageUpdate, GetMessagesOptions, MessagesPage } from "../types/index.js";
import * as messageQueries from "../db/queries/messages.js";
import * as interpretationQueries from "../db/queries/interpretations.js";
import type { EventBus } from "../shared/EventBus.js";
import type { EnrichmentService } from "./EnrichmentService.js";

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

export class MessageService {
  constructor(
    private pool: pg.Pool,
    private eventBus?: EventBus,
    private enrichmentService?: EnrichmentService,
  ) {}

  async storeMessage(msg: StoreMessageInput): Promise<Message> {
    const message = await messageQueries.upsertMessage(this.pool, msg);
    this.eventBus?.emit({ type: "message:created", data: message });
    await this.autoEnqueue(message, msg.attachments);
    return message;
  }

  async storeMessages(msgs: StoreMessageInput[]): Promise<Message[]> {
    const results: Message[] = [];
    for (const msg of msgs) {
      results.push(await this.storeMessage(msg));
    }
    return results;
  }

  async updateMessage(channelId: string, ts: string, updates: MessageUpdate): Promise<Message> {
    const result = await messageQueries.updateMessage(this.pool, channelId, ts, updates);
    if (!result) {
      throw new Error(`Message not found: channel=${channelId}, ts=${ts}`);
    }
    this.eventBus?.emit({ type: "message:updated", data: result });
    return result;
  }

  async deleteMessage(channelId: string, ts: string): Promise<void> {
    return messageQueries.softDeleteMessage(this.pool, channelId, ts);
  }

  async getMessages(channelId: string, opts: GetMessagesOptions): Promise<MessagesPage> {
    return messageQueries.getMessages(this.pool, channelId, opts);
  }

  async getThread(channelId: string, threadTs: string): Promise<Message[]> {
    return messageQueries.getThread(this.pool, channelId, threadTs);
  }

  async compileContext(
    channelId: string,
    opts: { limit?: number; from?: string; to?: string },
  ): Promise<string> {
    const { messages } = await this.getMessages(channelId, opts);
    if (messages.length === 0) return "";

    const lines: string[] = [];

    for (const msg of messages) {
      const prefix = msg.is_bot ? `[봇] ${msg.user_name}` : msg.user_name;
      lines.push(`**${prefix}** (${msg.ts}):`);
      lines.push(msg.content);

      if (msg.reactions && Array.isArray(msg.reactions) && msg.reactions.length > 0) {
        const reactionStr = msg.reactions
          .map((r: { emoji: string; users: string[] }) => `:${r.emoji}: (${r.users.length})`)
          .join(" ");
        lines.push(`Reactions: ${reactionStr}`);
      }

      // Include thread replies inline
      if (!msg.thread_ts) {
        const thread = await messageQueries.getThread(this.pool, channelId, msg.ts);
        const replies = thread.filter((t) => t.ts !== msg.ts);
        if (replies.length > 0) {
          for (const reply of replies) {
            const rPrefix = reply.is_bot ? `[봇] ${reply.user_name}` : reply.user_name;
            lines.push(`  > **${rPrefix}** (${reply.ts}): ${reply.content}`);
          }
        }
      }

      // Include interpretations
      const interps = await interpretationQueries.getByMessage(this.pool, msg.id);
      for (const interp of interps) {
        lines.push(`  [해석/${interp.type}]: ${interp.content}`);
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  private async autoEnqueue(message: Message, attachments?: unknown[]): Promise<void> {
    if (!this.enrichmentService) return;

    // Extract URLs from content
    const urls = message.content.match(URL_REGEX) ?? [];
    for (const url of urls) {
      await this.enrichmentService.enqueue(message.id, "link_crawl", url);
    }

    // Enqueue attachments that have url properties
    if (attachments && Array.isArray(attachments)) {
      for (const attachment of attachments) {
        const att = attachment as Record<string, unknown>;
        if (typeof att.url === "string") {
          await this.enrichmentService.enqueue(message.id, "attachment", att.url);
        }
      }
    }
  }
}
