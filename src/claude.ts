import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";

const SKIP_TOKEN = "[SKIP]";

// Module-level session state — reused across messages for faster startup.
// Reset when compact_boundary fires (context too large) or on error.
let currentSessionId: string | null = null;

/** True when no active session exists — caller should inject channel context. */
export function isNewSession(): boolean {
  return currentSessionId === null;
}

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

export async function askClaudeDeepThink(
  config: Config,
  prompt: string,
): Promise<string | null> {
  let result: string | null = null;
  try {
    for await (const message of query({
      prompt,
      options: {
        maxTurns: 20,
        cwd: config.workspaceDir,
        settingSources: [],
        allowedTools: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        model: config.claudeModel,
      },
    })) {
      const msg = message as SDKMessage;
      if ("result" in msg && typeof msg.result === "string") {
        result = msg.result;
      }
    }
  } catch (err) {
    console.error("[DeepThink] askClaudeDeepThink error:", err);
    return null;
  }
  return result?.trim() ?? null;
}

/** Convert Slack ts (unix seconds) to KST "YYYY-MM-DD HH:MM" */
export function tsToDateTime(ts: string): string {
  const ms = parseFloat(ts) * 1000;
  if (Number.isNaN(ms)) return "????-??-?? ??:??";
  const d = new Date(ms + 9 * 3600 * 1000); // shift to KST
  const yyyy = d.getUTCFullYear();
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  return `${yyyy}-${mo}-${dd} ${hh}:${mm}`;
}

export function formatPrompt(
  channelId: string,
  threadTs: string,
  userId: string,
  userName: string,
  text: string,
  isBot = false,
): string {
  const datetime = tsToDateTime(threadTs);
  const botTag = isBot ? " [봇]" : "";
  return `[${channelId}:${threadTs}] [${datetime}] <${userId}> [${userName}${botTag}]\n${text}`;
}
