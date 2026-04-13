import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
import { getMessageTools, handleMessageTool } from "./handlers/messages.js";
import { getChannelTools, handleChannelTool } from "./handlers/channels.js";
import { getInterpretationTools, handleInterpretationTool } from "./handlers/interpretations.js";
import { getEnrichmentTools, handleEnrichmentTool } from "./handlers/enrichment.js";
import { MessageService } from "../services/MessageService.js";
import { ChannelService } from "../services/ChannelService.js";
import { InterpretationService } from "../services/InterpretationService.js";
import { EnrichmentService } from "../services/EnrichmentService.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const messageService = new MessageService(pool);
const channelService = new ChannelService(pool);
const interpretationService = new InterpretationService(pool);
const enrichmentService = new EnrichmentService(pool);

const allTools = [
  ...getMessageTools(),
  ...getChannelTools(),
  ...getInterpretationTools(),
  ...getEnrichmentTools(),
];

const messageToolNames = new Set(getMessageTools().map((t) => t.name));
const channelToolNames = new Set(getChannelTools().map((t) => t.name));
const interpretationToolNames = new Set(getInterpretationTools().map((t) => t.name));
const enrichmentToolNames = new Set(getEnrichmentTools().map((t) => t.name));

const server = new Server(
  { name: "remiel", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const params = (args ?? {}) as Record<string, unknown>;

  try {
    let result: unknown;

    if (messageToolNames.has(name)) {
      result = await handleMessageTool(name, params, messageService);
    } else if (channelToolNames.has(name)) {
      result = await handleChannelTool(name, params, channelService);
    } else if (interpretationToolNames.has(name)) {
      result = await handleInterpretationTool(name, params, interpretationService);
    } else if (enrichmentToolNames.has(name)) {
      result = await handleEnrichmentTool(name, params, enrichmentService);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Remiel MCP] Server running on stdio");
}

main().catch((err) => {
  console.error("[Remiel MCP] Fatal error:", err);
  process.exit(1);
});
