export interface Channel {
  id: string;
  name: string;
  source: string;
  interpretation_enabled: boolean;
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
  reply_count: number;
  latest_interpretation: string | null;
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
  /** 단방향 범위 조회 시작(포함). Slack `ts` 문자열 형식. */
  from?: string;
  /** 단방향 범위 조회 끝(포함). Slack `ts` 문자열 형식. */
  to?: string;
  /** 반환할 최대 메시지 수. 1~100 clamp, 기본 50. */
  limit?: number;
  /**
   * `ts:id` 형식의 커서. 이 메시지 **이전**(과거 방향)을 조회한다.
   * 예: `"1234567890.123456:uuid-abc"`.
   * 잘못된 포맷은 조용히 무시되고 `latest` 모드로 동작한다.
   */
  before?: string;
  /**
   * `ts:id` 형식의 커서. 이 메시지 **이후**(미래 방향)을 조회한다.
   * 예: `"1234567890.123456:uuid-abc"`.
   * 잘못된 포맷은 조용히 무시되고 `latest` 모드로 동작한다.
   */
  after?: string;
}

/**
 * 커서 페이지네이션 결과.
 *
 * - `messages`: 시간 오름차순(ASC)으로 정렬된 실제 페이지.
 * - `oldestCursor` / `newestCursor`: 페이지 경계의 `ts:id` 커서.
 *   빈 페이지면 둘 다 `null`.
 * - `hasMoreOlder` / `hasMoreNewer`: 해당 방향으로 더 가져올 데이터가 있는지.
 */
export interface MessagesPage {
  messages: Message[];
  oldestCursor: string | null;
  newestCursor: string | null;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
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

export interface InterpretationPrompt {
  key: string;
  content: string;
  created_at: string;
  updated_at: string;
}

/** 수신자 정보 (user_id + 표시명) */
export interface Addressee {
  id: string;
  name: string;
}

/** 구조화된 맥락 해석 결과 (메시지 1개에 대한 해석) */
export interface ContextInterpretation {
  message_id: string;
  addressees: Addressee[];
  intent: string;
  summary: string;
  confidence: number;
  adversarial_note: string | null;
}

export type InterpretationLookupStatus =
  | "ready"
  | "disabled_channel"
  | "missing_message"
  | "missing_interpretation"
  | "low_confidence"
  | "stale"
  | "invalid_metadata";

export interface InterpretationLookupInput {
  channel_id: string;
  timestamps: string[];
  confidence_threshold?: number;
}

export interface InterpretationLookupReadyItem {
  ts: string;
  message_id: string;
  status: "ready";
  summary: string;
  intent: string;
  addressees: Addressee[];
  confidence: number;
  adversarial_note: string | null;
  created_at: string;
}

export interface InterpretationLookupUnresolvedItem {
  ts: string;
  status: Exclude<InterpretationLookupStatus, "ready">;
  message_id?: string;
  confidence?: number;
  threshold?: number;
  created_at?: string;
  updated_at?: string;
}

export type InterpretationLookupItem =
  | InterpretationLookupReadyItem
  | InterpretationLookupUnresolvedItem;

export interface InterpretationLookupCoverage {
  requested: number;
  ready: number;
  needs_reasoning: number;
  disabled_channel: number;
  missing_message: number;
  missing_interpretation: number;
  low_confidence: number;
  stale: number;
  invalid_metadata: number;
}

export interface InterpretationLookupResult {
  channel_id: string;
  channel_enabled: boolean;
  confidence_threshold: number;
  coverage: InterpretationLookupCoverage;
  items: InterpretationLookupItem[];
}
