import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createSlackApp } from "./slack.js";
import { TimingLogger } from "./timing.js";
import { DelegationManager } from "./delegation.js";
import { DeepThinkManager } from "./deepthink.js";
import { MessageForwarder } from "./forwarder.js";
import { UserResolver } from "./user-resolver.js";
import { HANIEL_READY_CONDITION, READINESS_MARKER } from "./readiness.js";

export { HANIEL_READY_CONDITION, READINESS_MARKER } from "./readiness.js";

export interface BootstrapDependencies {
  createSlackApp: typeof createSlackApp;
}

const DEFAULT_BOOTSTRAP_DEPENDENCIES: BootstrapDependencies = { createSlackApp };

export async function main(
  dependencies: BootstrapDependencies = DEFAULT_BOOTSTRAP_DEPENDENCIES,
) {
  const config = loadConfig();

  console.log(`[Remiel] Starting...`);
  console.log(`[Remiel] Model: ${config.claudeModel}`);
  console.log(`[Remiel] Workspace: ${config.workspaceDir}`);
  if (config.slackChannelIds.length > 0) {
    console.log(`[Remiel] Response channels: ${config.slackChannelIds.join(", ")}`);
  } else {
    console.log(`[Remiel] Record-only mode (no response channels configured)`);
  }

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

  const forwarder =
    config.remielServerUrl && config.remielApiKey
      ? new MessageForwarder(config.remielServerUrl, config.remielApiKey)
      : null;

  if (forwarder) {
    console.log(`[Remiel] Forwarder enabled (server: ${config.remielServerUrl})`);
  } else {
    console.log(`[Remiel] Forwarder disabled (REMIEL_SERVER_URL/API_KEY not set)`);
  }

  const app = await dependencies.createSlackApp(
    config,
    timingLogger,
    delegationManager,
    deepThinkManager,
    forwarder,
  );
  deepThinkManager.setApp(app);
  delegationManager?.setApp(app);

  // UserResolver and WebClient need app.client — inject after app creation
  if (forwarder) {
    forwarder.setUserResolver(new UserResolver(app.client));
    forwarder.setWebClient(app.client);
  }

  await app.start();

  // Register explicitly configured channels with remiel-server
  // (other channels are auto-registered on first message)
  if (forwarder && config.slackChannelIds.length > 0) {
    forwarder
      .registerChannels(config.slackChannelIds, app.client)
      .catch((err) => console.error("[Forwarder] Channel registration failed:", err));
  }

  console.log(READINESS_MARKER);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`[Remiel] Fatal error:`, error);
    process.exit(1);
  });
}
