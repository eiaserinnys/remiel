export interface Channel {
  id: string;
  name: string;
  source: string;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
}

export interface Attachment {
  url: string;
  name: string;
  size?: number;
  type?: string;
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
  attachments: Attachment[];
  reactions: { emoji: string; users: string[] }[];
  is_bot: boolean;
  created_at: string;
  updated_at: string;
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

export interface EnrichmentStatus {
  pending: number;
  processing: number;
  done: number;
  failed: number;
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

export interface EnrichmentItem {
  id: string;
  message_id: string;
  type: 'link_crawl' | 'attachment';
  target: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  result: CrawlResult | AttachmentResult | null;
  error: string | null;
  created_at: string;
}

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  getChannels: () => fetchJSON<Channel[]>('/api/channels'),

  getMessages: (channelId: string, opts?: { from?: string; to?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.from) params.set('from', opts.from);
    if (opts?.to) params.set('to', opts.to);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return fetchJSON<Message[]>(`/api/channels/${channelId}/messages${qs ? '?' + qs : ''}`);
  },

  getThread: (channelId: string, threadTs: string) =>
    fetchJSON<Message[]>(`/api/channels/${channelId}/threads/${threadTs}`),

  getInterpretations: (messageId: string) =>
    fetchJSON<Interpretation[]>(`/api/messages/${messageId}/interpretations`),

  getThreadInterpretations: (channelId: string, threadTs: string) =>
    fetchJSON<Interpretation[]>(`/api/channels/${channelId}/threads/${threadTs}/interpretations`),

  getEnrichmentStatus: () => fetchJSON<EnrichmentStatus>('/api/enrichment/status'),

  getEnrichments: (messageId: string) =>
    fetchJSON<EnrichmentItem[]>(`/api/messages/${messageId}/enrichments`),

  /** Returns a proxied URL for Slack private files */
  fileProxyUrl: (url: string) =>
    `/api/files/proxy?url=${encodeURIComponent(url)}`,
};
