import "dotenv/config";
import { getPool } from "./db/pool.js";
import { createServer } from "./api/server.js";
import { MessageService } from "./services/MessageService.js";
import { ChannelService } from "./services/ChannelService.js";
import { InterpretationService } from "./services/InterpretationService.js";
import { EnrichmentService } from "./services/EnrichmentService.js";
import { EventBus } from "./shared/EventBus.js";
import { EnrichmentWorker } from "./worker/EnrichmentWorker.js";
import { registerRoutes } from "./api/routes.js";
import { migrate } from "./db/migrate.js";

async function main() {
  const pool = getPool();
  await migrate(pool);

  const eventBus = new EventBus();
  const enrichmentService = new EnrichmentService(pool);
  const messageService = new MessageService(pool, eventBus, enrichmentService);
  const channelService = new ChannelService(pool);
  const interpretationService = new InterpretationService(pool, eventBus);

  const server = await createServer();
  registerRoutes(server, { messageService, channelService, interpretationService, enrichmentService, eventBus });

  // Start enrichment worker in background
  const worker = new EnrichmentWorker(pool, eventBus);
  worker.start().catch((err) => {
    console.error("[EnrichmentWorker] Fatal error:", err);
  });

  const port = parseInt(process.env.PORT ?? "3120");
  await server.listen({ host: "0.0.0.0", port });
  console.log(`[Remiel Server] Listening on port ${port}`);

  // Graceful shutdown
  const shutdown = async () => {
    worker.stop();
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
