import pg from "pg";
import type { Channel, RegisterChannelInput } from "../types/index.js";
import * as channelQueries from "../db/queries/channels.js";

export class ChannelService {
  constructor(private pool: pg.Pool) {}

  async register(input: RegisterChannelInput): Promise<Channel> {
    return channelQueries.upsertChannel(this.pool, input);
  }

  async list(): Promise<Channel[]> {
    return channelQueries.listChannels(this.pool);
  }

  async update(id: string, updates: { interpretation_enabled?: boolean }): Promise<Channel> {
    return channelQueries.updateChannel(this.pool, id, updates);
  }
}
