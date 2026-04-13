import type { App } from "@slack/bolt";

type WebClient = App["client"];

export class UserResolver {
  private cache = new Map<string, string>();

  constructor(private client: WebClient) {}

  async resolve(userId: string): Promise<string> {
    const cached = this.cache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.client.users.info({ user: userId });
      const name =
        result.user?.profile?.display_name ||
        result.user?.real_name ||
        result.user?.name ||
        userId;
      this.cache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }
}
