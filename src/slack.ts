import { App } from "@slack/bolt";
import type { Config } from "./config.js";
import { MessageQueue, type QueuedMessage } from "./queue.js";
import { askClaude, isNewSession, formatPrompt } from "./claude.js";

interface SlackMessage {
  channel: string;
  user?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  username?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

// Track recent response timestamps for frequency hint injection
const recentResponses: number[] = [];

function countRecentResponses(windowMs = 30 * 60 * 1000): number {
  const cutoff = Date.now() - windowMs;
  while (recentResponses.length > 0 && recentResponses[0] < cutoff) {
    recentResponses.shift();
  }
  return recentResponses.length;
}

async function fetchChannelContext(app: App, channelId: string): Promise<string> {
  try {
    const result = await app.client.conversations.history({
      channel: channelId,
      limit: 15,
    });

    const messages = [...(result.messages ?? [])].reverse();
    const lines = messages
      .map((msg) => {
        const speaker = msg.bot_profile?.name ?? msg.username ?? msg.user ?? "unknown";
        const text = (msg.text ?? "").trim();
        if (!text) return null;
        return `[${speaker}]: ${text}`;
      })
      .filter((line): line is string => line !== null);

    return lines.join("\n");
  } catch {
    return "";
  }
}

async function dmOperator(app: App, config: Config, text: string): Promise<void> {
  if (!config.operatorUserId) return;
  try {
    await app.client.chat.postMessage({
      channel: config.operatorUserId,
      text,
    });
  } catch {
    // DM 실패는 조용히 무시
  }
}

export function createSlackApp(config: Config): App {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  const queue = new MessageQueue(async (msg: QueuedMessage) => {
    // Check before calling askClaude — session may reset inside the call too
    const needsContext = isNewSession();

    // Build prompt preamble
    let preamble = "";

    // [1] Channel context on new/reset session
    if (needsContext) {
      const history = await fetchChannelContext(app, msg.channelId);
      if (history) {
        preamble += `=== 채널 최근 메시지 (세션 시작 컨텍스트) ===\n${history}\n\n`;
      }
    }

    // [2] Inject frequency hint for Claude's SKIP judgment
    const recentCount = countRecentResponses();
    if (recentCount > 0) {
      preamble += `[레미엘 최근 30분 발언 횟수: ${recentCount}회]\n`;
    }

    const prompt = preamble + `[지침: 자신(레미엘)을 부르는 메시지가 아니면 반드시 [SKIP]으로만 응답한다.]\n` + formatPrompt(
      msg.channelId,
      msg.threadTs,
      msg.userId,
      msg.userName,
      msg.text,
    );

    console.log(`[Bot] Processing: ${msg.userName} > ${msg.text.slice(0, 50)}`);

    const response = await askClaude(config, prompt);

    if (response.compacted) {
      console.log(`[Bot] Session compacted — reset`);
      await dmOperator(app, config, `[pre_compaction] 세션 리셋됨`);
    }

    if (response.skipped) {
      console.log(`[Bot] Skipped`);
      await dmOperator(
        app,
        config,
        `[SKIP] ${msg.userName}: ${msg.text.slice(0, 100)}`,
      );
      return;
    }

    await app.client.chat.postMessage({
      channel: msg.channelId,
      text: response.text!,
    });

    // Record this response for frequency tracking
    recentResponses.push(Date.now());

    console.log(`[Bot] Replied: ${response.text!.slice(0, 50)}`);
  });

  // Resolve user display name from Slack API
  const userNameCache = new Map<string, string>();

  async function resolveUserName(userId: string): Promise<string> {
    const cached = userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await app.client.users.info({ user: userId });
      const name =
        result.user?.profile?.display_name ||
        result.user?.real_name ||
        result.user?.name ||
        userId;
      userNameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  const channelSet = new Set(config.slackChannelIds);

  app.message(async ({ message }) => {
    const msg = message as SlackMessage;

    // Filter: only monitored channels
    if (!channelSet.has(msg.channel)) return;

    // Filter: ignore bot messages
    if (msg.bot_id) return;

    // Filter: ignore thread replies (main channel only)
    if (msg.thread_ts) return;

    const text = msg.text;
    if (!text || !text.trim()) return;

    const userId = msg.user;
    if (!userId) return;

    const userName = await resolveUserName(userId);
    const threadTs = msg.thread_ts ?? msg.ts;

    queue.enqueue({
      channelId: msg.channel,
      threadTs,
      userId,
      userName,
      text,
    });
  });

  return app;
}
