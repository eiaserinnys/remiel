export interface Channel {
  id: string;
  name: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface RegisterChannelInput {
  id: string;
  name: string;
  source?: string;
}

export interface Message {
  id: string;
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  user_id: string;
  user_name: string;
  avatar_url: string | null;
  content: string;
  attachments: unknown[];
  reactions: Reaction[];
  is_bot: boolean;
  is_deleted: boolean;
  source_edited: boolean;
  enrichment_count: number;
  created_at: string;
  updated_at: string;
}

export interface Reaction {
  emoji: string;
  users: string[];
}

export interface StoreMessageInput {
  channel_id: string;
  ts: string;
  thread_ts?: string;
  user_id: string;
  user_name: string;
  avatar_url?: string;
  content: string;
  attachments?: unknown[];
  reactions?: Reaction[];
  is_bot?: boolean;
}

export interface MessageUpdate {
  content?: string;
  source_edited?: boolean;
  attachments?: unknown[];
  reaction_add?: { emoji: string; user: string };
  reaction_remove?: { emoji: string; user: string };
}

export interface Interpretation {
  id: string;
  channel_id: string;
  message_id: string | null;
  thread_ts: string | null;
  type: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface StoreInterpretationInput {
  channel_id: string;
  message_id?: string;
  thread_ts?: string;
  type?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface EnrichmentStatus {
  pending: number;
  processing: number;
  done: number;
  failed: number;
}

export interface GetMessagesOptions {
  from?: string;
  to?: string;
  limit?: number;
}

export interface EnrichmentQueueItem {
  id: string;
  message_id: string;
  type: "link_crawl" | "attachment";
  target: string;
  status: "pending" | "processing" | "done" | "failed";
  result: unknown;
  error: string | null;
  retry_count: number;
  max_retries: number;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrawlResult {
  title: string | null;
  description: string | null;
  image: string | null;
  excerpt: string | null;
  fetched_at: string;
}

export interface AttachmentResult {
  content_type: string | null;
  content_length: number | null;
  verified_at: string;
}
