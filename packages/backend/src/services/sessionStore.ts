import { v4 as uuid } from "uuid";
import type {
  ChatMessage,
  Session,
  SessionWithMessages,
  ToolCall,
  ToolResult,
} from "@vladbot/shared";
import pool from "./db.js";
import { deleteSessionFiles } from "./sessionFiles.js";

// Helpers

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    title: row.title as string,
    autoApprove: row.auto_approve as boolean,
    model: (row.model as string) ?? "",
    visionModel: (row.vision_model as string) ?? "",
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function rowToMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row.id as string,
    role: row.role as ChatMessage["role"],
    content: row.content as string,
    images: row.images
      ? (row.images as string[])
      : undefined,
    model: (row.model as string) ?? undefined,
    timestamp: Number(row.timestamp),
    toolCalls: row.tool_calls
      ? (row.tool_calls as ToolCall[])
      : undefined,
    toolResults: row.tool_results
      ? (row.tool_results as ToolResult[])
      : undefined,
    approvalStatus:
      (row.approval_status as ChatMessage["approvalStatus"]) ?? undefined,
    llmRequest: row.llm_request ?? undefined,
    llmResponse: row.llm_response ?? undefined,
    verbatimCount: row.verbatim_count != null ? Number(row.verbatim_count) : undefined,
    tokenCount: row.token_count != null ? Number(row.token_count) : undefined,
    rawTokenCount: row.raw_token_count != null ? Number(row.raw_token_count) : undefined,
  };
}

// Public API

/**
 * Create a new session. `model` should be in "provider:modelId" format.
 */
export async function createSession(
  title: string = "New chat",
  model?: string,
  visionModel?: string,
): Promise<Session> {
  const id = uuid();
  const result = await pool.query(
    `INSERT INTO sessions (id, title, model, vision_model) VALUES ($1, $2, $3, $4)
     RETURNING id, title, auto_approve, model, vision_model, created_at, updated_at`,
    [id, title, model ?? null, visionModel ?? null],
  );
  return rowToSession(result.rows[0]);
}

export async function listSessions(): Promise<Session[]> {
  const result = await pool.query(
    `SELECT id, title, auto_approve, model, vision_model, created_at, updated_at
     FROM sessions ORDER BY updated_at DESC`,
  );
  return result.rows.map(rowToSession);
}

export async function getSession(id: string): Promise<SessionWithMessages | null> {
  const sessionResult = await pool.query(
    `SELECT id, title, auto_approve, model, vision_model, token_usage, created_at, updated_at
     FROM sessions WHERE id = $1`,
    [id],
  );
  if (sessionResult.rows.length === 0) return null;

  const session = rowToSession(sessionResult.rows[0]);
  const rawTokenUsage = sessionResult.rows[0].token_usage as
    | { inputTokens: number; outputTokens: number }
    | null;

  const messagesResult = await pool.query(
    `SELECT id, session_id, role, content, images, model, tool_calls, tool_results, approval_status, timestamp, llm_request, llm_response, verbatim_count, token_count, raw_token_count
     FROM messages WHERE session_id = $1 ORDER BY timestamp ASC`,
    [id],
  );
  const messages: ChatMessage[] = messagesResult.rows.map(rowToMessage);

  return {
    ...session,
    messages,
    tokenUsage: rawTokenUsage ?? undefined,
  };
}

export async function getMessages(
  sessionId: string,
  opts: { before?: number; limit?: number } = {},
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const limit = opts.limit ?? 30;
  const conditions = ["session_id = $1"];
  const values: unknown[] = [sessionId];

  if (opts.before != null) {
    conditions.push(`timestamp < $${values.length + 1}`);
    values.push(opts.before);
  }

  values.push(limit + 1); // fetch one extra to determine hasMore
  const result = await pool.query(
    `SELECT id, session_id, role, content, images, model, tool_calls, tool_results,
            approval_status, timestamp, llm_request, llm_response, verbatim_count, token_count, raw_token_count
     FROM messages WHERE ${conditions.join(" AND ")}
     ORDER BY timestamp DESC
     LIMIT $${values.length}`,
    values,
  );

  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit).reverse();
  return { messages: rows.map(rowToMessage), hasMore };
}

export async function updateSessionTitle(
  id: string,
  title: string,
): Promise<Session | null> {
  const result = await pool.query(
    `UPDATE sessions SET title = $1, updated_at = now() WHERE id = $2
     RETURNING id, title, auto_approve, model, vision_model, created_at, updated_at`,
    [title, id],
  );
  if (result.rows.length === 0) return null;
  return rowToSession(result.rows[0]);
}

export async function getSessionAutoApprove(sessionId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT auto_approve FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (result.rows.length === 0) return false;
  return result.rows[0].auto_approve as boolean;
}

/**
 * Update a session. `model` should be in "provider:modelId" format.
 */
export async function updateSession(
  id: string,
  updates: { title?: string; autoApprove?: boolean; model?: string; visionModel?: string },
): Promise<Session | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.title !== undefined) {
    sets.push(`title = $${idx++}`);
    values.push(updates.title);
  }
  if (updates.autoApprove !== undefined) {
    sets.push(`auto_approve = $${idx++}`);
    values.push(updates.autoApprove);
  }
  if (updates.model !== undefined) {
    sets.push(`model = $${idx++}`);
    values.push(updates.model);
  }
  if (updates.visionModel !== undefined) {
    sets.push(`vision_model = $${idx++}`);
    values.push(updates.visionModel);
  }
  if (sets.length === 0) return null;

  sets.push("updated_at = now()");
  values.push(id);

  const result = await pool.query(
    `UPDATE sessions SET ${sets.join(", ")} WHERE id = $${idx}
     RETURNING id, title, auto_approve, model, vision_model, created_at, updated_at`,
    values,
  );
  if (result.rows.length === 0) return null;
  return rowToSession(result.rows[0]);
}

/**
 * Returns the model in "provider:modelId" format.
 * null = session not found, "" = no model set.
 */
export async function getSessionModel(
  sessionId: string,
): Promise<string | null> {
  const result = await pool.query(
    `SELECT model FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (result.rows.length === 0) return null;
  return (result.rows[0].model as string) ?? "";
}

/**
 * Returns the vision model in "provider:modelId" format.
 * null = session not found, "" = no vision model set.
 */
export async function getSessionVisionModel(
  sessionId: string,
): Promise<string | null> {
  const result = await pool.query(
    `SELECT vision_model FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (result.rows.length === 0) return null;
  return (result.rows[0].vision_model as string) ?? "";
}

export async function deleteSession(id: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM sessions WHERE id = $1 RETURNING id`,
    [id],
  );
  if (result.rowCount && result.rowCount > 0) {
    deleteSessionFiles(id);
    return true;
  }
  return false;
}

export async function updateSessionTokenUsage(
  id: string,
  tokenUsage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  await pool.query(
    `UPDATE sessions SET token_usage = $1, updated_at = now() WHERE id = $2`,
    [JSON.stringify(tokenUsage), id],
  );
}

export async function addMessage(sessionId: string, message: ChatMessage): Promise<string> {
  const result = await pool.query(
    `INSERT INTO messages (id, session_id, role, content, images, model, tool_calls, tool_results, approval_status, timestamp, llm_request, llm_response, verbatim_count, token_count, raw_token_count)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      message.id || null,
      sessionId,
      message.role,
      message.content,
      message.images ? JSON.stringify(message.images) : null,
      message.model ?? null,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolResults ? JSON.stringify(message.toolResults) : null,
      message.approvalStatus ?? null,
      message.timestamp,
      message.llmRequest ? JSON.stringify(message.llmRequest) : null,
      message.llmResponse ? JSON.stringify(message.llmResponse) : null,
      message.verbatimCount ?? null,
      message.tokenCount ?? null,
      message.rawTokenCount ?? null,
    ],
  );
  await pool.query(
    `UPDATE sessions SET updated_at = now() WHERE id = $1`,
    [sessionId],
  );
  return result.rows[0].id as string;
}

export async function deleteMessages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(`DELETE FROM messages WHERE id = ANY($1::uuid[])`, [ids]);
}

export async function searchSessionMessages(params: {
  sessionId: string;
  query: string;
  role?: string;
  limit?: number;
  offset?: number;
}): Promise<{ messages: ChatMessage[]; total: number }> {
  const limit = Math.min(params.limit ?? 20, 50);
  const offset = params.offset ?? 0;

  const result = await searchSessionMessagesInternal(params, limit, offset, "fts");

  // Trigram fallback: if full-text search found nothing, retry with ILIKE
  if (result.total === 0) {
    return searchSessionMessagesInternal(params, limit, offset, "trigram");
  }

  return result;
}

async function searchSessionMessagesInternal(
  params: { sessionId: string; query: string; role?: string },
  limit: number,
  offset: number,
  mode: "fts" | "trigram",
): Promise<{ messages: ChatMessage[]; total: number }> {
  const conditions = ["session_id = $1"];
  const values: unknown[] = [params.sessionId];

  if (mode === "fts") {
    conditions.push(
      "to_tsvector('english', coalesce(content, '')) @@ websearch_to_tsquery('english', $2)",
    );
    values.push(params.query);
  } else {
    conditions.push("content ILIKE $2");
    values.push(`%${params.query}%`);
  }

  if (params.role) {
    values.push(params.role);
    conditions.push(`role = $${values.length}`);
  }

  const where = conditions.join(" AND ");

  const countResult = await pool.query(
    `SELECT count(*)::int AS total FROM messages WHERE ${where}`,
    values,
  );

  const rankExpr = mode === "fts"
    ? "ts_rank(to_tsvector('english', coalesce(content, '')), websearch_to_tsquery('english', $2)) AS rank"
    : "1 AS rank";

  values.push(limit, offset);
  const dataResult = await pool.query(
    `SELECT id, session_id, role, content, images, model, tool_calls, tool_results, approval_status, timestamp,
            ${rankExpr}
     FROM messages WHERE ${where}
     ORDER BY rank DESC, timestamp DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return {
    messages: dataResult.rows.map(rowToMessage),
    total: countResult.rows[0].total,
  };
}

export async function searchAllMessages(params: {
  query: string;
  excludeSessionId?: string;
  role?: string;
  limit?: number;
  offset?: number;
}): Promise<{ messages: Array<ChatMessage & { sessionId: string; sessionTitle: string }>; total: number }> {
  const limit = Math.min(params.limit ?? 20, 50);
  const offset = params.offset ?? 0;

  const result = await searchAllMessagesInternal(params, limit, offset, "fts");

  // Trigram fallback: if full-text search found nothing, retry with ILIKE
  if (result.total === 0) {
    return searchAllMessagesInternal(params, limit, offset, "trigram");
  }

  return result;
}

async function searchAllMessagesInternal(
  params: { query: string; excludeSessionId?: string; role?: string },
  limit: number,
  offset: number,
  mode: "fts" | "trigram",
): Promise<{ messages: Array<ChatMessage & { sessionId: string; sessionTitle: string }>; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (mode === "fts") {
    conditions.push(
      "to_tsvector('english', coalesce(m.content, '')) @@ websearch_to_tsquery('english', $1)",
    );
    values.push(params.query);
  } else {
    conditions.push("m.content ILIKE $1");
    values.push(`%${params.query}%`);
  }

  if (params.excludeSessionId) {
    values.push(params.excludeSessionId);
    conditions.push(`m.session_id != $${values.length}`);
  }
  if (params.role) {
    values.push(params.role);
    conditions.push(`m.role = $${values.length}`);
  }

  const where = conditions.join(" AND ");

  const countResult = await pool.query(
    `SELECT count(*)::int AS total FROM messages m WHERE ${where}`,
    values,
  );

  const rankExpr = mode === "fts"
    ? "ts_rank(to_tsvector('english', coalesce(m.content, '')), websearch_to_tsquery('english', $1)) AS rank"
    : "1 AS rank";

  values.push(limit, offset);
  const dataResult = await pool.query(
    `SELECT m.id, m.session_id, m.role, m.content, m.images, m.model,
            m.tool_calls, m.tool_results, m.approval_status, m.timestamp,
            s.title AS session_title,
            ${rankExpr}
     FROM messages m
     JOIN sessions s ON s.id = m.session_id
     WHERE ${where}
     ORDER BY rank DESC, m.timestamp DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return {
    messages: dataResult.rows.map((row) => ({
      ...rowToMessage(row),
      sessionId: row.session_id as string,
      sessionTitle: row.session_title as string,
    })),
    total: countResult.rows[0].total,
  };
}

/**
 * Atomically set approval_status to "approved" only if it's currently "pending".
 * Returns true if the update happened, false if another request already approved it.
 */
export async function atomicApprove(messageId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE messages SET approval_status = 'approved' WHERE id = $1 AND approval_status = 'pending'`,
    [messageId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateMessage(
  messageId: string,
  updates: {
    content?: string;
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
    approvalStatus?: string | null;
    llmRequest?: unknown;
    llmResponse?: unknown;
    rawTokenCount?: number;
  },
): Promise<void> {
  const current = await pool.query(
    `SELECT content, tool_calls, tool_results, approval_status, llm_request, llm_response, raw_token_count FROM messages WHERE id = $1`,
    [messageId],
  );
  if (current.rows.length === 0) return;

  const row = current.rows[0];
  await pool.query(
    `UPDATE messages SET content = $1, tool_calls = $2, tool_results = $3, approval_status = $4, llm_request = $5, llm_response = $6, raw_token_count = $7
     WHERE id = $8`,
    [
      updates.content ?? (row.content as string),
      updates.toolCalls !== undefined
        ? JSON.stringify(updates.toolCalls)
        : row.tool_calls !== undefined
          ? JSON.stringify(row.tool_calls)
          : null,
      updates.toolResults !== undefined
        ? JSON.stringify(updates.toolResults)
        : row.tool_results !== undefined
          ? JSON.stringify(row.tool_results)
          : null,
      updates.approvalStatus !== undefined
        ? updates.approvalStatus
        : (row.approval_status as string | null),
      updates.llmRequest !== undefined
        ? JSON.stringify(updates.llmRequest)
        : row.llm_request !== undefined
          ? JSON.stringify(row.llm_request)
          : null,
      updates.llmResponse !== undefined
        ? JSON.stringify(updates.llmResponse)
        : row.llm_response !== undefined
          ? JSON.stringify(row.llm_response)
          : null,
      updates.rawTokenCount ?? (row.raw_token_count != null ? Number(row.raw_token_count) : null),
      messageId,
    ],
  );
}
