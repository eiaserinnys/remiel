import "dotenv/config";
import { getPool } from "./db/pool.js";
import { createServer } from "./api/server.js";
import { MessageService } from "./services/MessageService.js";
import { ChannelService } from "./services/ChannelService.js";
import { InterpretationService } from "./services/InterpretationService.js";
import { EnrichmentService } from "./services/EnrichmentService.js";
import { registerRoutes } from "./api/routes.js";
import { migrate } from "./db/migrate.js";

async function main() {
  const pool = getPool();
  await migrate(pool);

  const messageService = new MessageService(pool);
  const channelService = new ChannelService(pool);
  const interpretationService = new InterpretationService(pool);
  const enrichmentService = new EnrichmentService(pool);

  const server = await createServer();
  registerRoutes(server, { messageService, channelService, interpretationService, enrichmentService });

  const port = parseInt(process.env.PORT ?? "3120");
  await server.listen({ host: "0.0.0.0", port });
  console.log(`[Remiel Server] Listening on port ${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
