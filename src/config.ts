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
  anthropicApiKey: string;
  claudeModel: string;
  workspaceDir: string;
  botName: string;
}

export function loadConfig(): Config {
  return {
    slackBotToken: requireEnv("SLACK_BOT_TOKEN"),
    slackAppToken: requireEnv("SLACK_APP_TOKEN"),
    slackChannelIds: requireEnv("SLACK_CHANNEL_IDS").split(",").map((s) => s.trim()),
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    claudeModel: process.env["CLAUDE_MODEL"] ?? "claude-sonnet-4-6",
    workspaceDir: requireEnv("WORKSPACE_DIR"),
    botName: process.env["BOT_NAME"] ?? "레미엘",
  };
}
