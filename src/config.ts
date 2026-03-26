import "dotenv/config";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  slackChannelIds: string[];
  claudeModel: string;
  workspaceDir: string;
  botName: string;
  operatorUserId?: string;
  soulstreamUrl?: string;
  soulstreamToken?: string;
  soulstreamAgentId?: string;
}

export function loadConfig(): Config {
  return {
    slackBotToken: requireEnv("SLACK_BOT_TOKEN"),
    slackAppToken: requireEnv("SLACK_APP_TOKEN"),
    slackChannelIds: requireEnv("SLACK_CHANNEL_IDS").split(",").map((s) => s.trim()),
    claudeModel: process.env["CLAUDE_MODEL"] ?? "claude-sonnet-4-6",
    workspaceDir: requireEnv("WORKSPACE_DIR"),
    botName: process.env["BOT_NAME"] ?? "레미엘",
    operatorUserId: process.env["OPERATOR_USER_ID"],
    soulstreamUrl: process.env["SOULSTREAM_URL"],
    soulstreamToken: process.env["SOULSTREAM_TOKEN"],
    soulstreamAgentId: process.env["SOULSTREAM_AGENT_ID"],
  };
}
