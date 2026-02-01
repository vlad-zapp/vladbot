import pg from "pg";
import { env } from "../config/env.js";

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
});

await pool.query(`
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS "pg_trgm";

  CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'compaction')),
    content TEXT NOT NULL DEFAULT '',
    model TEXT,
    tool_calls JSONB,
    tool_results JSONB,
    approval_status TEXT CHECK (approval_status IN ('pending', 'approved', 'denied') OR approval_status IS NULL),
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  ALTER TABLE messages ADD COLUMN IF NOT EXISTS images JSONB;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_usage JSONB;
  ALTER TABLE messages ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS llm_request JSONB;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS llm_response JSONB;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS verbatim_count INTEGER;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS token_count INTEGER;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS raw_token_count INTEGER;

  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp);

  CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    header TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT[] NOT NULL DEFAULT '{}',
    token_count INTEGER NOT NULL DEFAULT 0,
    search_vector TSVECTOR GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(header, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(body, '')), 'B')
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_memories_search_vector ON memories USING GIN(search_vector);
  CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING GIN(tags);
  CREATE INDEX IF NOT EXISTS idx_memories_session_id ON memories(session_id);
  CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
  CREATE INDEX IF NOT EXISTS idx_memories_header_trgm ON memories USING GIN(header gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_memories_body_trgm ON memories USING GIN(body gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS idx_messages_content_trgm ON messages USING GIN(content gin_trgm_ops);

  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auto_approve BOOLEAN NOT NULL DEFAULT false;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`);

export default pool;
