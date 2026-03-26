import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";

const SKIP_TOKEN = "[SKIP]";

// Module-level session state — reused across messages for faster startup.
// Reset when compact_boundary fires (context too large) or on error.
let currentSessionId: string | null = null;

export interface ClaudeResponse {
  text: string | null;
  skipped: boolean;
  compacted: boolean;
}

export async function askClaude(
  config: Config,
  prompt: string,
): Promise<ClaudeResponse> {
  let result: string | null = null;
  let compacted = false;

  const resumingSessionId = currentSessionId;

  try {
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
        ...(resumingSessionId ? { resume: resumingSessionId } : {}),
      },
    })) {
      const msg = message as SDKMessage;

      if (msg.type === "system" && msg.subtype === "init") {
        currentSessionId = msg.session_id;
      }

      if (msg.type === "system" && msg.subtype === "compact_boundary") {
        // Context was compacted — start fresh next turn
        currentSessionId = null;
        compacted = true;
      }

      if ("result" in msg && typeof msg.result === "string") {
        result = msg.result;
      }
    }
  } catch (err) {
    // On error, drop the session so the next call starts clean
    currentSessionId = null;
    throw err;
  }

  if (!result) {
    return { text: null, skipped: true, compacted };
  }

  const trimmed = result.trim();
  if (trimmed === SKIP_TOKEN || trimmed.startsWith(SKIP_TOKEN)) {
    return { text: null, skipped: true, compacted };
  }

  return { text: trimmed, skipped: false, compacted };
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
