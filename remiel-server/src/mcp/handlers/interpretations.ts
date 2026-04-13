import type { InterpretationService } from "../../services/InterpretationService.js";
import type { StoreInterpretationInput } from "../../types/index.js";

export function getInterpretationTools() {
  return [
    {
      name: "store_interpretation",
      description: "Store an interpretation for a message or thread",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string" },
          message_id: { type: "string", description: "Message UUID" },
          thread_ts: { type: "string", description: "Thread timestamp" },
          type: { type: "string", description: "Interpretation type (default: summary)" },
          content: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["channel_id", "content"],
      },
    },
    {
      name: "get_interpretations",
      description: "Get interpretations by message_id or by channel+thread_ts",
      inputSchema: {
        type: "object" as const,
        properties: {
          message_id: { type: "string" },
          channel_id: { type: "string" },
          thread_ts: { type: "string" },
        },
      },
    },
  ];
}

export async function handleInterpretationTool(
  name: string,
  args: Record<string, unknown>,
  interpretationService: InterpretationService,
): Promise<unknown> {
  switch (name) {
    case "store_interpretation":
      return interpretationService.store(args as unknown as StoreInterpretationInput);

    case "get_interpretations": {
      if (args.message_id) {
        return interpretationService.getByMessage(args.message_id as string);
      }
      if (args.channel_id && args.thread_ts) {
        return interpretationService.getByThread(args.channel_id as string, args.thread_ts as string);
      }
      throw new Error("Either message_id or (channel_id + thread_ts) is required");
    }

    default:
      throw new Error(`Unknown interpretation tool: ${name}`);
  }
}
