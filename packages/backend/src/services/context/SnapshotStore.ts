import { v4 as uuid } from "uuid";
import type { ChatMessage, ToolCall, ToolResult } from "@vladbot/shared";
import pool from "../db.js";

/**
 * Represents a context snapshot - a pre-computed LLM context state after compaction.
 */
export interface ContextSnapshot {
  id: string;
  sessionId: string;
  createdAt: Date;
  summary: string;
  summaryTokenCount: number;
  verbatimMessageIds: string[];
  verbatimTokenCount: number;
  totalTokenCount: number;
  triggerTokenCount: number;
  modelUsed: string;
}

/**
 * Data required to create a new snapshot.
 */
export interface CreateSnapshotParams {
  sessionId: string;
  summary: string;
  summaryTokenCount: number;
  verbatimMessageIds: string[];
  verbatimTokenCount: number;
  triggerTokenCount: number;
  modelUsed: string;
}

/**
 * Convert a database row to a ContextSnapshot.
 */
function rowToSnapshot(row: Record<string, unknown>): ContextSnapshot {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    createdAt: row.created_at as Date,
    summary: row.summary as string,
    summaryTokenCount: row.summary_token_count as number,
    verbatimMessageIds: (row.verbatim_message_ids as string[]) ?? [],
    verbatimTokenCount: row.verbatim_token_count as number,
    totalTokenCount: row.total_token_count as number,
    triggerTokenCount: row.trigger_token_count as number,
    modelUsed: row.model_used as string,
  };
}

/**
 * Convert a database row to a ChatMessage.
 */
function rowToMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row.id as string,
    role: row.role as ChatMessage["role"],
    content: row.content as string,
    images: row.images ? (row.images as string[]) : undefined,
    model: (row.model as string) ?? undefined,
    timestamp: Number(row.timestamp),
    toolCalls: row.tool_calls ? (row.tool_calls as ToolCall[]) : undefined,
    toolResults: row.tool_results ? (row.tool_results as ToolResult[]) : undefined,
    approvalStatus: (row.approval_status as ChatMessage["approvalStatus"]) ?? undefined,
    verbatimCount: row.verbatim_count != null ? Number(row.verbatim_count) : undefined,
    tokenCount: row.token_count != null ? Number(row.token_count) : undefined,
    rawTokenCount: row.raw_token_count != null ? Number(row.raw_token_count) : undefined,
  };
}

/**
 * Create a new context snapshot.
 */
export async function createSnapshot(params: CreateSnapshotParams): Promise<ContextSnapshot> {
  const id = uuid();
  const totalTokenCount = params.summaryTokenCount + params.verbatimTokenCount;

  const result = await pool.query(
    `INSERT INTO context_snapshots
     (id, session_id, summary, summary_token_count, verbatim_message_ids,
      verbatim_token_count, total_token_count, trigger_token_count, model_used)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      id,
      params.sessionId,
      params.summary,
      params.summaryTokenCount,
      params.verbatimMessageIds,
      params.verbatimTokenCount,
      totalTokenCount,
      params.triggerTokenCount,
      params.modelUsed,
    ],
  );

  return rowToSnapshot(result.rows[0]);
}

/**
 * Get the active snapshot for a session.
 * Returns null if no snapshot exists (session never compacted).
 */
export async function getActiveSnapshot(sessionId: string): Promise<ContextSnapshot | null> {
  const result = await pool.query(
    `SELECT cs.* FROM context_snapshots cs
     JOIN sessions s ON s.active_snapshot_id = cs.id
     WHERE s.id = $1`,
    [sessionId],
  );

  if (result.rows.length === 0) return null;
  return rowToSnapshot(result.rows[0]);
}

/**
 * Get a snapshot by ID.
 */
export async function getSnapshotById(snapshotId: string): Promise<ContextSnapshot | null> {
  const result = await pool.query(
    `SELECT * FROM context_snapshots WHERE id = $1`,
    [snapshotId],
  );

  if (result.rows.length === 0) return null;
  return rowToSnapshot(result.rows[0]);
}

/**
 * Get messages by their IDs, preserving the order of the input IDs.
 */
export async function getMessagesByIds(ids: string[]): Promise<ChatMessage[]> {
  if (ids.length === 0) return [];

  // Use array_position to maintain order
  const result = await pool.query(
    `SELECT id, session_id, role, content, images, model, tool_calls, tool_results,
            approval_status, timestamp, verbatim_count, token_count, raw_token_count
     FROM messages
     WHERE id = ANY($1::uuid[])
     ORDER BY array_position($1::uuid[], id)`,
    [ids],
  );

  return result.rows.map(rowToMessage);
}

/**
 * Set the active snapshot for a session.
 */
export async function setActiveSnapshot(sessionId: string, snapshotId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET active_snapshot_id = $1, updated_at = now() WHERE id = $2`,
    [snapshotId, sessionId],
  );
}

/**
 * Update the session's running token count.
 */
export async function updateSessionTokenCount(sessionId: string, tokenCount: number): Promise<void> {
  await pool.query(
    `UPDATE sessions SET current_token_count = $1, updated_at = now() WHERE id = $2`,
    [tokenCount, sessionId],
  );
}

/**
 * Get the session's current token count.
 */
export async function getSessionTokenCount(sessionId: string): Promise<number> {
  const result = await pool.query(
    `SELECT current_token_count FROM sessions WHERE id = $1`,
    [sessionId],
  );

  if (result.rows.length === 0) return 0;
  return (result.rows[0].current_token_count as number) ?? 0;
}

/**
 * Increment the session's token count by a delta and return the new total.
 */
export async function incrementSessionTokenCount(sessionId: string, delta: number): Promise<number> {
  const result = await pool.query(
    `UPDATE sessions
     SET current_token_count = current_token_count + $1, updated_at = now()
     WHERE id = $2
     RETURNING current_token_count`,
    [delta, sessionId],
  );

  if (result.rows.length === 0) return 0;
  return result.rows[0].current_token_count as number;
}

/**
 * Get all messages for a session after a given timestamp.
 */
export async function getMessagesAfterTimestamp(
  sessionId: string,
  timestamp: number,
): Promise<ChatMessage[]> {
  const result = await pool.query(
    `SELECT id, session_id, role, content, images, model, tool_calls, tool_results,
            approval_status, timestamp, verbatim_count, token_count, raw_token_count
     FROM messages
     WHERE session_id = $1 AND timestamp > $2
     ORDER BY timestamp ASC`,
    [sessionId, timestamp],
  );

  return result.rows.map(rowToMessage);
}

/**
 * Get all snapshots for a session, ordered by creation time (newest first).
 */
export async function getSessionSnapshots(sessionId: string): Promise<ContextSnapshot[]> {
  const result = await pool.query(
    `SELECT * FROM context_snapshots
     WHERE session_id = $1
     ORDER BY created_at DESC`,
    [sessionId],
  );

  return result.rows.map(rowToSnapshot);
}
