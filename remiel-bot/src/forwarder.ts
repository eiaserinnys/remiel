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
  files?: SlackFile[];
}

export class MessageForwarder {
  private userResolver!: UserResolver;

  constructor(
    private serverUrl: string,
    private apiKey: string,
  ) {}

  setUserResolver(resolver: UserResolver): void {
    this.userResolver = resolver;
  }

  async forwardMessage(event: MessageEvent): Promise<void> {
    const userName = event.user
      ? await this.userResolver.resolve(event.user)
      : undefined;

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
        user_id: event.user ?? null,
        user_name: userName ?? null,
        content: event.text ?? null,
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

  async registerChannels(
    channelIds: string[],
    client: WebClient,
  ): Promise<void> {
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
      } catch (err) {
        console.error(`[Forwarder] Failed to register channel ${id}:`, err);
      }
    }
  }
}
