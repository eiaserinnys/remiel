import type { ChannelService } from "../../services/ChannelService.js";

export function getChannelTools() {
  return [
    {
      name: "register_channel",
      description: "Register or update a channel",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Channel ID" },
          name: { type: "string", description: "Channel name" },
          source: { type: "string", description: "Source platform (default: slack)" },
        },
        required: ["id", "name"],
      },
    },
    {
      name: "list_channels",
      description: "List all registered channels",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];
}

export async function handleChannelTool(
  name: string,
  args: Record<string, unknown>,
  channelService: ChannelService,
): Promise<unknown> {
  switch (name) {
    case "register_channel":
      return channelService.register({
        id: args.id as string,
        name: args.name as string,
        source: args.source as string | undefined,
      });
    case "list_channels":
      return channelService.list();
    default:
      throw new Error(`Unknown channel tool: ${name}`);
  }
}
