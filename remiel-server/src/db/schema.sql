-- Remiel Conversation Store Schema

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'slack',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      TEXT NOT NULL REFERENCES channels(id),
  ts              TEXT NOT NULL,
  thread_ts       TEXT,
  user_id         TEXT NOT NULL,
  user_name       TEXT NOT NULL,
  content         TEXT NOT NULL,
  attachments     JSONB NOT NULL DEFAULT '[]',
  reactions       JSONB NOT NULL DEFAULT '[]',
  is_bot          BOOLEAN NOT NULL DEFAULT false,
  is_deleted      BOOLEAN NOT NULL DEFAULT false,
  source_edited   BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages (channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (channel_id, thread_ts) WHERE thread_ts IS NOT NULL;

CREATE TABLE IF NOT EXISTS enrichment_queue (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID NOT NULL REFERENCES messages(id),
  type        TEXT NOT NULL CHECK (type IN ('link_crawl', 'attachment')),
  target      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  result      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enrichment_status ON enrichment_queue (status);

CREATE TABLE IF NOT EXISTS interpretations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  TEXT NOT NULL REFERENCES channels(id),
  message_id  UUID REFERENCES messages(id),
  thread_ts   TEXT,
  type        TEXT NOT NULL DEFAULT 'summary',
  content     TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interpretations_message ON interpretations (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interpretations_thread ON interpretations (channel_id, thread_ts) WHERE thread_ts IS NOT NULL;
