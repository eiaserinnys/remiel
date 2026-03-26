import "dotenv/config";
import { loadConfig } from "./config.js";
import { createSlackApp } from "./slack.js";
import { TimingLogger } from "./timing.js";

async function main() {
  const config = loadConfig();

  console.log(`[Remiel] Starting...`);
  console.log(`[Remiel] Model: ${config.claudeModel}`);
  console.log(`[Remiel] Workspace: ${config.workspaceDir}`);
  console.log(`[Remiel] Monitoring channels: ${config.slackChannelIds.join(", ")}`);

  const timingLogger = new TimingLogger(config.workspaceDir);
  await timingLogger.initialize();

  const app = createSlackApp(config, timingLogger);
  await app.start();

  console.log(`[Remiel] Bot is running!`);
}

main().catch((error) => {
  console.error(`[Remiel] Fatal error:`, error);
  process.exit(1);
});
