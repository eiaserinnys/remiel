import "dotenv/config";
import { loadConfig } from "./config.js";
import { createSlackApp } from "./slack.js";
import { TimingLogger } from "./timing.js";
import { DelegationManager } from "./delegation.js";
import { DeepThinkManager } from "./deepthink.js";

async function main() {
  const config = loadConfig();

  console.log(`[Remiel] Starting...`);
  console.log(`[Remiel] Model: ${config.claudeModel}`);
  console.log(`[Remiel] Workspace: ${config.workspaceDir}`);
  console.log(`[Remiel] Monitoring channels: ${config.slackChannelIds.join(", ")}`);

  const timingLogger = new TimingLogger(config.workspaceDir);
  await timingLogger.initialize();

  const delegationManager =
    config.soulstreamUrl && config.soulstreamToken && config.soulstreamAgentId
      ? new DelegationManager(
          config.soulstreamUrl,
          config.soulstreamToken,
          config.soulstreamAgentId,
          undefined,
          config.delegationDumpChannelId,
        )
      : null;

  if (delegationManager) {
    console.log(`[Remiel] Delegation enabled (soulstream: ${config.soulstreamUrl})`);
  } else {
    console.log(`[Remiel] Delegation disabled (SOULSTREAM_URL/TOKEN/AGENT_ID not set)`);
  }

  const deepThinkManager = new DeepThinkManager(config, config.deepThinkDumpChannelId);

  const app = await createSlackApp(config, timingLogger, delegationManager, deepThinkManager);
  deepThinkManager.setApp(app);
  delegationManager?.setApp(app);
  await app.start();

  console.log(`[Remiel] Bot is running!`);
}

main().catch((error) => {
  console.error(`[Remiel] Fatal error:`, error);
  process.exit(1);
});
