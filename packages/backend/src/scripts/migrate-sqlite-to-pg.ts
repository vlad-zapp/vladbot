/**
 * One-time migration script: SQLite → PostgreSQL
 *
 * Usage:
 *   npx tsx packages/backend/src/scripts/migrate-sqlite-to-pg.ts
 *
 * Prerequisites:
 *   - PostgreSQL running with DATABASE_URL configured in .env
 *   - SQLite database at data/vladbot.db
 *   - better-sqlite3 still installed (run this BEFORE removing it)
 */

import Database from "better-sqlite3";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const SQLITE_PATH = path.resolve(__dirname, "../../../../data/vladbot.db");
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL not set in .env");
  process.exit(1);
}

const sqlite = new Database(SQLITE_PATH, { readonly: true });
const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function migrate() {
  console.log(`SQLite source: ${SQLITE_PATH}`);
  console.log(`PostgreSQL target: ${DATABASE_URL?.replace(/\/\/.*@/, "//***@")}`);
  console.log();

  // Create schema
  console.log("Creating PostgreSQL schema...");
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      title TEXT NOT NULL DEFAULT 'New chat',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
      content TEXT NOT NULL DEFAULT '',
      model TEXT,
      tool_calls JSONB,
      tool_results JSONB,
      approval_status TEXT CHECK (approval_status IN ('pending', 'approved', 'denied') OR approval_status IS NULL),
      timestamp BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

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
  `);

  // Migrate sessions
  const sessions = sqlite.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
  console.log(`Migrating ${sessions.length} sessions...`);

  for (const session of sessions) {
    const createdAt = normalizeDate(session.created_at as string);
    const updatedAt = normalizeDate(session.updated_at as string);

    await pool.query(
      `INSERT INTO sessions (id, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [session.id, session.title, createdAt, updatedAt],
    );
  }

  // Migrate messages
  const messages = sqlite.prepare("SELECT * FROM messages").all() as Record<string, unknown>[];
  console.log(`Migrating ${messages.length} messages...`);

  for (const msg of messages) {
    const createdAt = normalizeDate(msg.created_at as string);

    // SQLite stores tool_calls/tool_results as JSON text strings
    // PostgreSQL JSONB needs them parsed, but pg driver handles JSON objects
    let toolCalls = null;
    if (msg.tool_calls) {
      try {
        toolCalls = JSON.parse(msg.tool_calls as string);
      } catch {
        toolCalls = msg.tool_calls;
      }
    }

    let toolResults = null;
    if (msg.tool_results) {
      try {
        toolResults = JSON.parse(msg.tool_results as string);
      } catch {
        toolResults = msg.tool_results;
      }
    }

    await pool.query(
      `INSERT INTO messages (id, session_id, role, content, model, tool_calls, tool_results, approval_status, timestamp, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        msg.id,
        msg.session_id,
        msg.role,
        msg.content,
        msg.model ?? null,
        toolCalls ? JSON.stringify(toolCalls) : null,
        toolResults ? JSON.stringify(toolResults) : null,
        msg.approval_status ?? null,
        msg.timestamp,
        createdAt,
      ],
    );
  }

  // Verify
  const pgSessions = await pool.query("SELECT COUNT(*)::int AS count FROM sessions");
  const pgMessages = await pool.query("SELECT COUNT(*)::int AS count FROM messages");

  console.log();
  console.log("Migration complete:");
  console.log(`  Sessions: ${sessions.length} SQLite → ${pgSessions.rows[0].count} PostgreSQL`);
  console.log(`  Messages: ${messages.length} SQLite → ${pgMessages.rows[0].count} PostgreSQL`);

  if (pgSessions.rows[0].count >= sessions.length && pgMessages.rows[0].count >= messages.length) {
    console.log("  ✓ All rows migrated successfully");
  } else {
    console.log("  ⚠ Row count mismatch — some rows may have had conflicts");
  }

  sqlite.close();
  await pool.end();
}

function normalizeDate(dateStr: string): string {
  if (!dateStr) return new Date().toISOString();
  // SQLite datetime('now') produces "YYYY-MM-DD HH:MM:SS" without timezone
  // Append Z to treat as UTC
  if (!dateStr.endsWith("Z") && !dateStr.includes("+") && !dateStr.includes("T")) {
    return dateStr.replace(" ", "T") + "Z";
  }
  return dateStr;
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
