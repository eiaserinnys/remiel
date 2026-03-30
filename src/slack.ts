import { App } from "@slack/bolt";
import type { Config } from "./config.js";
import { MessageQueue, type QueuedMessage } from "./queue.js";
import { askClaude, isNewSession, formatPrompt, tsToDateTime } from "./claude.js";
import { TimingLogger } from "./timing.js";
import { DelegationManager, parseRequests, stripRequests } from "./delegation.js";
import { DeepThinkManager } from "./deepthink.js";

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

// Track recent response timestamps for frequency-aware intervention probability
const recentResponses: number[] = [];

const BURST_FLOOR = 3;
const BURST_CEIL = 7;

function countRecentResponses(windowMs = 30 * 60 * 1000): number {
  const cutoff = Date.now() - windowMs;
  while (recentResponses.length > 0 && recentResponses[0] < cutoff) {
    recentResponses.shift();
  }
  return recentResponses.length;
}

function interventionProbability(recentCount: number): number {
  if (recentCount >= BURST_CEIL) return 0.0;

  if (recentCount < BURST_FLOOR) {
    const base = 0.88 - recentCount * 0.04;
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.min(1.0, base * jitter);
  }

  // soft wall between FLOOR and CEIL: quadratic decay
  const t = (recentCount - BURST_FLOOR) / (BURST_CEIL - BURST_FLOOR);
  const base = 0.8 * Math.pow(1 - t, 2);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.max(0.0, base * jitter);
}

async function fetchChannelContext(app: App, channelId: string, limit = 15): Promise<string> {
  try {
    const result = await app.client.conversations.history({
      channel: channelId,
      limit,
    });

    const messages = [...(result.messages ?? [])].reverse();
    const lines = messages
      .map((msg) => {
        const userId = msg.user ?? msg.bot_id ?? "unknown";
        const text = (msg.text ?? "").trim();
        if (!text) return null;
        const ts = msg.ts ?? "0";
        const datetime = tsToDateTime(ts);
        const botTag = msg.bot_id ? " [봇]" : "";
        return `[${channelId}:${ts}] [${datetime}] <${userId}>${botTag}: ${text}`;
      })
      .filter((line): line is string => line !== null);

    return [
      '<channel-history description="아래는 레미엘 채널의 최근 대화입니다.">',
      lines.join("\n"),
      "</channel-history>",
    ].join("\n");
  } catch {
    return "";
  }
}

export function parseDeepThinks(text: string): string[] {
  // 완성된 태그 쌍
  const matches = [...text.matchAll(/<deepthink>([\s\S]*?)<\/deepthink>/g)];
  const results = matches.map(m => m[1].trim()).filter(Boolean);
  // 닫히지 않은 태그 (응답 잘림)
  const unclosed = /<deepthink>([\s\S]*)$/.exec(text.replace(/<deepthink>[\s\S]*?<\/deepthink>/g, ""));
  if (unclosed) {
    const content = unclosed[1].trim();
    if (content) results.push(content);
  }
  return results;
}

export function stripDeepThinks(text: string): string {
  // 완성된 태그 쌍 제거
  let result = text.replace(/<deepthink>[\s\S]*?<\/deepthink>/g, "");
  // 닫히지 않은 태그 (개행 태그 포함, 응답 잘림) 제거
  result = result.replace(/<deepthink>[\s\S]*$/, "");
  return result.trim();
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

function dmHeader(userName: string, isBot: boolean, badge: string): string {
  const botTag = isBot ? " [봇]" : "";
  return `*${userName}${botTag} \`${badge}\`*`;
}

export async function createSlackApp(
  config: Config,
  timingLogger: TimingLogger,
  delegationManager: DelegationManager | null = null,
  deepThinkManager: DeepThinkManager | null = null,
): Promise<App> {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  // Identify our own bot_id and user_id to avoid self-triggering and enable mention detection
  const authResult = await app.client.auth.test();
  const selfBotId = authResult.bot_id as string | undefined;
  const selfBotUserId = authResult.user_id as string | undefined;
  if (!selfBotUserId) {
    throw new Error("[Bot] auth.test()가 user_id를 반환하지 않았습니다. 봇 초기화를 중단합니다.");
  }

  const queue = new MessageQueue(async (msg: QueuedMessage) => {
    const dequeuedAt = Date.now();
    const timingCtx = {
      receivedAt: msg.receivedAt,
      msgTs: msg.threadTs,
      user: msg.userName,
      text: msg.text,
    };

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

    // [2] Delegation preamble injection
    const delegationPreamble = delegationManager?.getPreamble() ?? "";
    if (delegationPreamble) {
      preamble += delegationPreamble + "\n";
    }

    // [3] DeepThink 현황
    const deepThinkPreamble = deepThinkManager?.getPreamble() ?? "";
    if (deepThinkPreamble) {
      preamble += deepThinkPreamble + "\n";
    }

    // [4] Frequency-aware SKIP directive injection
    const recentCount = countRecentResponses();
    const prob = interventionProbability(recentCount);
    const frequencyGated = Math.random() > prob;

    const skipDirective = frequencyGated
      ? `[지침: 최근 발언이 많았기 때문에 자신(레미엘)을 직접 부르는 메시지가 아니면 반드시 [SKIP]으로만 응답한다.]\n`
      : ``;

    const botIdDirective = `[시스템: 당신(레미엘)의 Slack User ID는 ${selfBotUserId}입니다. 메시지 텍스트에 <@${selfBotUserId}>가 없으면 직접 호출된 것이 아닙니다.]\n`;

    const prompt = preamble + botIdDirective + skipDirective + formatPrompt(
      msg.channelId,
      msg.threadTs,
      msg.userId,
      msg.userName,
      msg.text,
      msg.isBot,
    );

    console.log(`[Bot] Processing: ${msg.userName} > ${msg.text.slice(0, 50)}`);

    const claudeStartAt = Date.now();
    const response = await askClaude(config, prompt);
    const claudeDoneAt = Date.now();

    if (response.compacted) {
      console.log(`[Bot] Session compacted — reset`);
      await dmOperator(app, config, `[pre_compaction] 세션 리셋됨`);
    }

    if (response.skipped) {
      console.log(`[Bot] Skipped`);
      await dmOperator(
        app,
        config,
        `${dmHeader(msg.userName, msg.isBot, "💤SKIP")}\n${msg.text.slice(0, 200)}`,
      );
      await timingLogger.record(timingCtx, dequeuedAt, claudeStartAt, claudeDoneAt, null, true);
      return;
    }

    // Detect <request> tags and delegate to seosoyoung
    if (delegationManager && response.text) {
      const requests = parseRequests(response.text);
      if (requests.length > 0) {
        const channelContext = await fetchChannelContext(app, msg.channelId);
        for (const content of requests) {
          try {
            const reqId = await delegationManager.delegate(content, channelContext, msg.channelId);
            console.log(`[Delegation] Created request ${reqId}`);
          } catch (err) {
            console.error(`[Delegation] Failed to delegate:`, err);
          }
        }
      }
    }

    // Detect <deepthink> tags and start deep thinking
    if (deepThinkManager && response.text) {
      const deepThinks = parseDeepThinks(response.text);
      if (deepThinks.length > 0) {
        const deepThinkContext = await fetchChannelContext(app, msg.channelId, 30);
        for (const dtQuery of deepThinks) {
          try {
            const dtId = await deepThinkManager.think(dtQuery, deepThinkContext, msg.channelId);
            console.log(`[DeepThink] Started ${dtId}`);
          } catch (err) {
            console.error(`[DeepThink] Failed to start:`, err);
          }
        }
      }
    }

    const textToPost = stripDeepThinks(stripRequests(response.text!));
    let postedAt: number | null = null;
    if (textToPost) {
      await app.client.chat.postMessage({
        channel: msg.channelId,
        text: textToPost,
      });
      postedAt = Date.now();
    }

    await timingLogger.record(timingCtx, dequeuedAt, claudeStartAt, claudeDoneAt, postedAt, false);

    // Record this response for frequency tracking
    recentResponses.push(Date.now());

    const elapsedSec = ((claudeDoneAt - claudeStartAt) / 1000).toFixed(1);
    await dmOperator(
      app,
      config,
      `${dmHeader(msg.userName, msg.isBot, "✅CHECK")}\n${msg.text.slice(0, 200)}`,
    );
    if (textToPost) {
      await dmOperator(
        app,
        config,
        `*\`🗯️${elapsedSec}s elapsed\`*\n${textToPost.slice(0, 200)}`,
      );
      console.log(`[Bot] Replied: ${textToPost.slice(0, 50)}`);
    } else {
      console.log(`[Bot] Delegation only — no text posted`);
    }
  });

  // Register delegation completion callback — calls Claude directly with the result
  // and posts the response to the channel without going through the queue.
  if (delegationManager) {
    delegationManager.setOnComplete(async (channelId, requestId, status, finalResult) => {
      const preamble = delegationManager.getPreamble();
      const resultText = finalResult ? finalResult.slice(0, 500) : "";
      const systemPrompt = status === "completed"
        ? `${preamble}[시스템: 서소영 의뢰(${requestId})가 완료됐습니다. 결과: ${resultText}. 채널에 레미엘 캐릭터로 알려주세요.]`
        : `${preamble}[시스템: 서소영 의뢰(${requestId})가 실패했습니다. 채널에 레미엘 캐릭터로 알려주세요.]`;

      try {
        const response = await askClaude(config, systemPrompt);
        if (!response.skipped && response.text) {
          const textToPost = stripRequests(response.text);
          if (textToPost) {
            await app.client.chat.postMessage({ channel: channelId, text: textToPost });
            console.log(`[Delegation] Notified channel (${status}): ${textToPost.slice(0, 50)}`);
          }
        }
      } catch (err) {
        console.error(`[Delegation] Failed to notify channel:`, err);
      }
    });
  }

  // Register deepthink completion callback
  if (deepThinkManager) {
    deepThinkManager.setOnComplete(async (channelId, requestId, status, result) => {
      const preamble = deepThinkManager.getPreamble();
      const systemPrompt = status === "completed"
        ? `${preamble}[시스템: 딥씽크(${requestId}) 완료. 결과: ${result?.slice(0, 500)}. 채널에 이어서 발언해.]`
        : `${preamble}[시스템: 딥씽크(${requestId}) 실패. 적절히 마무리해.]`;
      try {
        const response = await askClaude(config, systemPrompt);
        if (!response.skipped && response.text) {
          const textToPost = stripDeepThinks(stripRequests(response.text));
          if (textToPost) {
            await app.client.chat.postMessage({ channel: channelId, text: textToPost });
            console.log(`[DeepThink] onComplete posted: ${textToPost.slice(0, 50)}`);
          }
        }
      } catch (err) {
        console.error(`[DeepThink] onComplete callback error:`, err);
      }
    });
  }

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

    // Filter: ignore own messages to prevent self-triggering
    if (msg.bot_id && msg.bot_id === selfBotId) return;

    // Filter: ignore thread replies (main channel only)
    if (msg.thread_ts) return;

    const text = msg.text;
    if (!text || !text.trim()) return;

    // Bot messages have no user field — fall back to bot_id
    const userId = msg.user ?? msg.bot_id;
    if (!userId) return;

    const userName = msg.user
      ? await resolveUserName(msg.user)
      : (msg.bot_profile?.name ?? msg.username ?? userId);
    const threadTs = msg.thread_ts ?? msg.ts;

    queue.enqueue({
      channelId: msg.channel,
      threadTs,
      userId,
      userName,
      text,
      isBot: !!msg.bot_id,
      receivedAt: Date.now(),
    });
  });

  return app;
}
