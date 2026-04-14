import type { App } from "@slack/bolt";

type WebClient = App["client"];

export interface UserInfo {
  name: string;
  avatarUrl: string | null;
}

export class UserResolver {
  private cache = new Map<string, UserInfo>();

  constructor(private client: WebClient) {}

  async resolve(userId: string): Promise<UserInfo> {
    const cached = this.cache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.client.users.info({ user: userId });
      const profile = result.user?.profile;
      const name =
        profile?.display_name ||
        result.user?.real_name ||
        result.user?.name ||
        userId;
      const avatarUrl = profile?.image_48 ?? profile?.image_72 ?? null;
      const info: UserInfo = { name, avatarUrl };
      this.cache.set(userId, info);
      return info;
    } catch {
      return { name: userId, avatarUrl: null };
    }
  }
}
