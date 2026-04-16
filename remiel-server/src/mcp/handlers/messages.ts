import type { MessageService } from "../../services/MessageService.js";
import type { StoreMessageInput, MessageUpdate } from "../../types/index.js";

export function getMessageTools() {
  return [
    {
      name: "store_message",
      description: "Store a single message (upsert on channel_id+ts)",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string" },
          ts: { type: "string", description: "Slack message timestamp" },
          thread_ts: { type: "string", description: "Thread parent timestamp" },
          user_id: { type: "string" },
          user_name: { type: "string" },
          content: { type: "string" },
          attachments: { type: "array", items: { type: "object" } },
          reactions: { type: "array", items: { type: "object" } },
          is_bot: { type: "boolean" },
        },
        required: ["channel_id", "ts", "user_id", "user_name", "content"],
      },
    },
    {
      name: "store_messages",
      description: "Store multiple messages in batch",
      inputSchema: {
        type: "object" as const,
        properties: {
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                channel_id: { type: "string" },
                ts: { type: "string" },
                thread_ts: { type: "string" },
                user_id: { type: "string" },
                user_name: { type: "string" },
                content: { type: "string" },
                attachments: { type: "array" },
                reactions: { type: "array" },
                is_bot: { type: "boolean" },
              },
              required: ["channel_id", "ts", "user_id", "user_name", "content"],
            },
          },
        },
        required: ["messages"],
      },
    },
    {
      name: "update_message",
      description: "Partially update a message (content, reactions, etc.)",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string" },
          ts: { type: "string" },
          updates: {
            type: "object",
            properties: {
              content: { type: "string" },
              source_edited: { type: "boolean" },
              attachments: { type: "array" },
              reaction_add: {
                type: "object",
                properties: { emoji: { type: "string" }, user: { type: "string" } },
              },
              reaction_remove: {
                type: "object",
                properties: { emoji: { type: "string" }, user: { type: "string" } },
              },
            },
          },
        },
        required: ["channel_id", "ts", "updates"],
      },
    },
    {
      name: "delete_message",
      description: "Soft-delete a message",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string" },
          ts: { type: "string" },
        },
        required: ["channel_id", "ts"],
      },
    },
    {
      name: "get_messages",
      description:
        "Get a page of messages for a channel. Returns { messages, oldestCursor, newestCursor, hasMoreOlder, hasMoreNewer }. Use `before`/`after` cursors for pagination, `from`/`to` for range queries.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string" },
          from: { type: "string", description: "Start timestamp (ts, inclusive)" },
          to: { type: "string", description: "End timestamp (ts, inclusive)" },
          before: { type: "string", description: "'ts:id' cursor — fetch messages older than this" },
          after: { type: "string", description: "'ts:id' cursor — fetch messages newer than this" },
          limit: { type: "number", description: "1..100, default 50" },
        },
        required: ["channel_id"],
      },
    },
    {
      name: "get_thread",
      description: "Get all messages in a thread",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string" },
          thread_ts: { type: "string" },
        },
        required: ["channel_id", "thread_ts"],
      },
    },
    {
      name: "compile_context",
      description: "Compile messages + interpretations into markdown context",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string" },
          limit: { type: "number" },
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["channel_id"],
      },
    },
  ];
}

export async function handleMessageTool(
  name: string,
  args: Record<string, unknown>,
  messageService: MessageService,
): Promise<unknown> {
  switch (name) {
    case "store_message":
      return messageService.storeMessage(args as unknown as StoreMessageInput);

    case "store_messages":
      return messageService.storeMessages(
        (args as { messages: StoreMessageInput[] }).messages,
      );

    case "update_message":
      return messageService.updateMessage(
        args.channel_id as string,
        args.ts as string,
        (args as { updates: MessageUpdate }).updates,
      );

    case "delete_message":
      await messageService.deleteMessage(args.channel_id as string, args.ts as string);
      return { success: true };

    case "get_messages":
      return messageService.getMessages(args.channel_id as string, {
        from: args.from as string | undefined,
        to: args.to as string | undefined,
        before: args.before as string | undefined,
        after: args.after as string | undefined,
        limit: args.limit as number | undefined,
      });

    case "get_thread":
      return messageService.getThread(args.channel_id as string, args.thread_ts as string);

    case "compile_context": {
      const markdown = await messageService.compileContext(args.channel_id as string, {
        limit: args.limit as number | undefined,
        from: args.from as string | undefined,
        to: args.to as string | undefined,
      });
      return { markdown };
    }

    default:
      throw new Error(`Unknown message tool: ${name}`);
  }
}
