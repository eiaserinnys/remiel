import { App } from "@slack/bolt";
import type { Config } from "./config.js";
import { MessageQueue, type QueuedMessage } from "./queue.js";
import { askClaude, formatPrompt } from "./claude.js";

interface SlackMessage {
  channel: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

export function createSlackApp(config: Config): App {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  const queue = new MessageQueue(async (msg: QueuedMessage) => {
    const prompt = formatPrompt(
      msg.channelId,
      msg.threadTs,
      msg.userId,
      msg.userName,
      msg.text,
    );

    console.log(`[Bot] Processing: ${msg.userName} > ${msg.text.slice(0, 50)}`);

    const response = await askClaude(config, prompt);

    if (response.skipped) {
      console.log(`[Bot] Skipped`);
      return;
    }

    await app.client.chat.postMessage({
      channel: msg.channelId,
      text: response.text!,
    });

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
