import "dotenv/config";
import { getPool } from "./db/pool.js";
import { createServer } from "./api/server.js";
import { MessageService } from "./services/MessageService.js";
import { ChannelService } from "./services/ChannelService.js";
import { InterpretationService } from "./services/InterpretationService.js";
import { EnrichmentService } from "./services/EnrichmentService.js";
import { EventBus } from "./shared/EventBus.js";
import { EnrichmentWorker } from "./worker/EnrichmentWorker.js";
import { InterpretationWorker } from "./worker/InterpretationWorker.js";
import { PromptService } from "./services/PromptService.js";
import { registerRoutes } from "./api/routes.js";
import { migrate } from "./db/migrate.js";
import { seedDefaultPrompt } from "./db/queries/prompts.js";

async function main() {
  const pool = getPool();
  await migrate(pool);

  const eventBus = new EventBus();
  const enrichmentService = new EnrichmentService(pool);
  const messageService = new MessageService(pool, eventBus, enrichmentService);
  const channelService = new ChannelService(pool);
  const interpretationService = new InterpretationService(pool, eventBus);

  const promptService = new PromptService(pool);

  const server = await createServer();
  const slackBotToken = process.env.SLACK_BOT_TOKEN;

  // Start interpretation worker (create before registerRoutes so routes can reference it)
  let interpretationWorker: InterpretationWorker | undefined;
  const interpretationEnabled = process.env.INTERPRETATION_ENABLED === "true";
  if (interpretationEnabled) {
    const soulstreamBaseUrl = process.env.SOULSTREAM_URL;
    const soulstreamAuthToken = process.env.SOULSTREAM_TOKEN;
    if (!soulstreamBaseUrl || !soulstreamAuthToken) {
      console.error("[InterpretationWorker] SOULSTREAM_URL and SOULSTREAM_TOKEN are required");
    } else {
      await seedDefaultPrompt(pool);
      interpretationWorker = new InterpretationWorker(pool, interpretationService, eventBus, {
        soulstreamBaseUrl,
        soulstreamAuthToken,
        soulstreamProfile: process.env.SOULSTREAM_AGENT_ID,
        soulstreamFolderId: process.env.SOULSTREAM_FOLDER_ID,
        soulstreamPreferredNodeId: process.env.SOULSTREAM_PREFERRED_NODE_ID,
        targetWindow: process.env.INTERPRETATION_TARGET_WINDOW
          ? parseInt(process.env.INTERPRETATION_TARGET_WINDOW, 10)
          : undefined,
        priorWindow: process.env.INTERPRETATION_PRIOR_WINDOW
          ? parseInt(process.env.INTERPRETATION_PRIOR_WINDOW, 10)
          : undefined,
      });
    }
  }

  registerRoutes(server, {
    messageService, channelService, interpretationService, enrichmentService,
    promptService, interpretationWorker, eventBus, slackBotToken,
  });

  // Start enrichment worker in background
  const enrichmentWorker = new EnrichmentWorker(pool, eventBus, {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
  });
  enrichmentWorker.start().catch((err) => {
    console.error("[EnrichmentWorker] Fatal error:", err);
  });

  // Start interpretation worker
  interpretationWorker?.start().catch((err) => {
    console.error("[InterpretationWorker] Fatal error:", err);
  });

  const port = parseInt(process.env.PORT ?? "3120");
  await server.listen({ host: "0.0.0.0", port });
  console.log(`[Remiel Server] Listening on port ${port}`);

  // Graceful shutdown
  const shutdown = async () => {
    enrichmentWorker.stop();
    interpretationWorker?.stop();
    await server.close();
    await pool.end();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
