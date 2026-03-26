import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";

const SKIP_TOKEN = "[SKIP]";

export interface ClaudeResponse {
  text: string | null;
  skipped: boolean;
}

export async function askClaude(
  config: Config,
  prompt: string,
): Promise<ClaudeResponse> {
  let result: string | null = null;

  for await (const message of query({
    prompt,
    options: {
      maxTurns: 1,
      cwd: config.workspaceDir,
      settingSources: ["project"],
      allowedTools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      model: config.claudeModel,
    },
  })) {
    if ("result" in message) {
      result = message.result;
    }
  }

  if (!result) {
    return { text: null, skipped: true };
  }

  const trimmed = result.trim();
  if (trimmed === SKIP_TOKEN || trimmed.startsWith(SKIP_TOKEN)) {
    return { text: null, skipped: true };
  }

  return { text: trimmed, skipped: false };
}

export function formatPrompt(
  channelId: string,
  threadTs: string,
  userId: string,
  userName: string,
  text: string,
): string {
  return `[${channelId}] [${threadTs}] [${userId}] [${userName}]\n${text}`;
}
