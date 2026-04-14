import type { UserResolver } from "./user-resolver.js";
import type { App } from "@slack/bolt";

type WebClient = App["client"];

interface SlackFile {
  name?: string;
  filetype?: string;
  url_private?: string;
  size?: number;
}

interface MessageEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string; icons?: { image_48?: string } };
  files?: SlackFile[];
}

export class MessageForwarder {
  private userResolver!: UserResolver;
  private registeredChannels = new Set<string>();

  constructor(
    private serverUrl: string,
    private apiKey: string,
  ) {}

  setUserResolver(resolver: UserResolver): void {
    this.userResolver = resolver;
  }

  async forwardMessage(event: MessageEvent): Promise<void> {
    // Auto-register channel on first message
    if (!this.registeredChannels.has(event.channel)) {
      this.autoRegisterChannel(event.channel).catch(() => {});
    }

    const userInfo = event.user
      ? await this.userResolver.resolve(event.user)
      : undefined;

    // For bot_message subtype, fall back to bot_id/username/bot_profile
    const userId = event.user ?? event.bot_id ?? "unknown";
    const userName = userInfo?.name
      ?? event.bot_profile?.name
      ?? event.username
      ?? userId;
    const avatarUrl = userInfo?.avatarUrl
      ?? event.bot_profile?.icons?.image_48
      ?? null;

    await fetch(`${this.serverUrl}/api/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        channel_id: event.channel,
        ts: event.ts,
        thread_ts: event.thread_ts ?? null,
        user_id: userId,
        user_name: userName,
        avatar_url: avatarUrl,
        content: event.text ?? "",
        attachments: (event.files ?? []).map((f) => ({
          name: f.name,
          type: f.filetype,
          url: f.url_private,
          size: f.size,
        })),
        is_bot: !!event.bot_id,
      }),
    });
  }

  async forwardUpdate(
    channelId: string,
    ts: string,
    updates: Record<string, unknown>,
  ): Promise<void> {
    await fetch(
      `${this.serverUrl}/api/messages/${encodeURIComponent(channelId)}/${encodeURIComponent(ts)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify(updates),
      },
    );
  }

  async forwardDelete(channelId: string, ts: string): Promise<void> {
    await fetch(
      `${this.serverUrl}/api/messages/${encodeURIComponent(channelId)}/${encodeURIComponent(ts)}`,
      {
        method: "DELETE",
        headers: { "x-api-key": this.apiKey },
      },
    );
  }

  private webClient: WebClient | null = null;

  setWebClient(client: WebClient): void {
    this.webClient = client;
  }

  private async autoRegisterChannel(channelId: string): Promise<void> {
    this.registeredChannels.add(channelId);
    if (!this.webClient) return;
    try {
      const info = await this.webClient.conversations.info({ channel: channelId });
      await fetch(`${this.serverUrl}/api/channels`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify({
          id: channelId,
          name: info.channel?.name ?? channelId,
          source: "slack",
        }),
      });
      console.log(`[Forwarder] Auto-registered channel ${info.channel?.name ?? channelId}`);
    } catch (err) {
      console.error(`[Forwarder] Failed to auto-register channel ${channelId}:`, err);
    }
  }

  async registerChannels(
    channelIds: string[],
    client: WebClient,
  ): Promise<void> {
    this.webClient = client;
    for (const id of channelIds) {
      try {
        const info = await client.conversations.info({ channel: id });
        await fetch(`${this.serverUrl}/api/channels`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
          },
          body: JSON.stringify({
            id,
            name: info.channel?.name ?? id,
            source: "slack",
          }),
        });
        this.registeredChannels.add(id);
      } catch (err) {
        console.error(`[Forwarder] Failed to register channel ${id}:`, err);
      }
    }
  }
}
