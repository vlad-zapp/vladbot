import type {
  Memory,
  MemoryListItem,
  MemoryListResponse,
  MemoryStats,
  MemoryCreateRequest,
  MemoryUpdateRequest,
} from "@vladbot/shared";
import pool from "./db.js";
import { countTokens } from "./tokenCounter.js";
import { env } from "../config/env.js";

// Helpers

function toISO(val: unknown): string {
  return val instanceof Date ? val.toISOString() : String(val);
}

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as string,
    header: row.header as string,
    body: row.body as string,
    tags: row.tags as string[],
    sessionId: (row.session_id as string) ?? null,
    tokenCount: row.token_count as number,
    createdAt: toISO(row.created_at),
    updatedAt: toISO(row.updated_at),
  };
}

function rowToMemoryListItem(row: Record<string, unknown>): MemoryListItem {
  return {
    id: row.id as string,
    header: row.header as string,
    tags: row.tags as string[],
    sessionId: (row.session_id as string) ?? null,
    tokenCount: row.token_count as number,
    createdAt: toISO(row.created_at),
    updatedAt: toISO(row.updated_at),
  };
}

// Public API

export async function listMemories(params: {
  query?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
  order?: "newest" | "oldest";
}): Promise<MemoryListResponse> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  const order = params.order === "oldest" ? "ASC" : "DESC";

  const result = await listMemoriesInternal(params.query, params.tags, limit, offset, order, "fts");

  // Trigram fallback: if full-text search found nothing, retry with ILIKE
  if (result.total === 0 && params.query) {
    return listMemoriesInternal(params.query, params.tags, limit, offset, order, "trigram");
  }

  return result;
}

async function listMemoriesInternal(
  query: string | undefined,
  tags: string[] | undefined,
  limit: number,
  offset: number,
  order: string,
  mode: "fts" | "trigram",
): Promise<MemoryListResponse> {
  const conditions: string[] = [];
  const queryParams: unknown[] = [];
  let paramIdx = 1;

  let rankSelect = "";
  let orderClause = `ORDER BY created_at ${order}`;

  if (query) {
    if (mode === "fts") {
      conditions.push(
        `search_vector @@ websearch_to_tsquery('english', $${paramIdx})`,
      );
      rankSelect = `, ts_rank(search_vector, websearch_to_tsquery('english', $${paramIdx})) AS rank`;
      orderClause = "ORDER BY rank DESC, created_at DESC";
    } else {
      const pattern = `%${query}%`;
      conditions.push(`(header ILIKE $${paramIdx} OR body ILIKE $${paramIdx})`);
      queryParams.push(pattern);
      paramIdx++;
      // Re-push is not needed; handled below. Adjust: we already pushed pattern.
      // Skip the push below.
    }
    if (mode === "fts") {
      queryParams.push(query);
      paramIdx++;
    }
  }

  if (tags && tags.length > 0) {
    conditions.push(`tags @> $${paramIdx}::text[]`);
    queryParams.push(tags);
    paramIdx++;
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM memories ${whereClause}`,
    queryParams.slice(),
  );
  const total = countResult.rows[0].total as number;

  const limitParamIdx = paramIdx;
  const offsetParamIdx = paramIdx + 1;
  queryParams.push(limit);
  queryParams.push(offset);

  const sql = `
    SELECT id, header, tags, session_id, token_count, created_at, updated_at${rankSelect}
    FROM memories
    ${whereClause}
    ${orderClause}
    LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
  `;

  const result = await pool.query(sql, queryParams);
  const memories = result.rows.map(rowToMemoryListItem);

  return { count: memories.length, total, memories };
}

/**
 * Search memories returning full Memory objects (including body).
 * Used by the AI tool which needs the body content and applies token truncation.
 */
export async function searchMemories(params: {
  query?: string;
  tags?: string[];
  dateFrom?: string;
  dateTo?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}): Promise<Memory[]> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);

  const results = await searchMemoriesInternal(params, limit, offset, "fts");

  // Trigram fallback: if full-text search found nothing, retry with ILIKE
  if (results.length === 0 && params.query) {
    return searchMemoriesInternal(params, limit, offset, "trigram");
  }

  return results;
}

async function searchMemoriesInternal(
  params: {
    query?: string;
    tags?: string[];
    dateFrom?: string;
    dateTo?: string;
    sessionId?: string;
  },
  limit: number,
  offset: number,
  mode: "fts" | "trigram",
): Promise<Memory[]> {
  const conditions: string[] = [];
  const queryParams: unknown[] = [];
  let paramIdx = 1;

  let rankSelect = "";
  let orderClause = "ORDER BY created_at DESC";

  if (params.query) {
    if (mode === "fts") {
      conditions.push(
        `search_vector @@ websearch_to_tsquery('english', $${paramIdx})`,
      );
      rankSelect = `, ts_rank(search_vector, websearch_to_tsquery('english', $${paramIdx})) AS rank`;
      orderClause = "ORDER BY rank DESC, created_at DESC";
      queryParams.push(params.query);
    } else {
      const pattern = `%${params.query}%`;
      conditions.push(`(header ILIKE $${paramIdx} OR body ILIKE $${paramIdx})`);
      queryParams.push(pattern);
    }
    paramIdx++;
  }

  if (params.tags && params.tags.length > 0) {
    conditions.push(`tags @> $${paramIdx}::text[]`);
    queryParams.push(params.tags);
    paramIdx++;
  }

  if (params.dateFrom) {
    conditions.push(`created_at >= $${paramIdx}::timestamptz`);
    queryParams.push(params.dateFrom);
    paramIdx++;
  }

  if (params.dateTo) {
    conditions.push(`created_at <= $${paramIdx}::timestamptz`);
    queryParams.push(params.dateTo);
    paramIdx++;
  }

  if (params.sessionId) {
    conditions.push(`(session_id = $${paramIdx} OR session_id IS NULL)`);
    queryParams.push(params.sessionId);
    paramIdx++;
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const limitParamIdx = paramIdx;
  const offsetParamIdx = paramIdx + 1;
  queryParams.push(limit);
  queryParams.push(offset);

  const sql = `
    SELECT id, header, body, tags, session_id, token_count, created_at, updated_at${rankSelect}
    FROM memories
    ${whereClause}
    ${orderClause}
    LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
  `;

  const result = await pool.query(sql, queryParams);
  return result.rows.map(rowToMemory);
}

export async function getMemory(id: string): Promise<Memory | null> {
  const result = await pool.query(
    `SELECT id, header, body, tags, session_id, token_count, created_at, updated_at
     FROM memories WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) return null;
  return rowToMemory(result.rows[0]);
}

export async function createMemory(data: MemoryCreateRequest): Promise<Memory> {
  const tokenCount = countTokens(data.header + " " + data.body);
  const tags = data.tags ?? [];
  const sessionId = data.sessionId ?? null;

  const totalResult = await pool.query(
    "SELECT COALESCE(SUM(token_count), 0)::int AS total FROM memories",
  );
  const currentTotal = totalResult.rows[0].total as number;

  if (currentTotal + tokenCount > env.MEMORY_MAX_STORAGE_TOKENS) {
    throw new Error(
      `Memory storage limit exceeded. Current usage: ${currentTotal} tokens. ` +
        `This entry would add ${tokenCount} tokens. Limit: ${env.MEMORY_MAX_STORAGE_TOKENS} tokens. ` +
        `Consider deleting old or less important memories before saving new ones.`,
    );
  }

  const result = await pool.query(
    `INSERT INTO memories (header, body, tags, session_id, token_count)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, header, body, tags, session_id, token_count, created_at, updated_at`,
    [data.header, data.body, tags, sessionId, tokenCount],
  );

  return rowToMemory(result.rows[0]);
}

export async function updateMemory(
  id: string,
  data: MemoryUpdateRequest,
): Promise<Memory | null> {
  const current = await pool.query(
    "SELECT header, body, tags, token_count FROM memories WHERE id = $1",
    [id],
  );

  if (current.rows.length === 0) return null;

  const row = current.rows[0];
  const newHeader = data.header ?? (row.header as string);
  const newBody = data.body ?? (row.body as string);
  const newTags = data.tags ?? (row.tags as string[]);
  const newTokenCount = countTokens(newHeader + " " + newBody);
  const oldTokenCount = row.token_count as number;

  if (newTokenCount > oldTokenCount) {
    const totalResult = await pool.query(
      "SELECT COALESCE(SUM(token_count), 0)::int AS total FROM memories",
    );
    const currentTotal = totalResult.rows[0].total as number;
    const delta = newTokenCount - oldTokenCount;
    if (currentTotal + delta > env.MEMORY_MAX_STORAGE_TOKENS) {
      throw new Error(
        `Update would exceed storage limit. Need ${delta} additional tokens ` +
          `but only ${env.MEMORY_MAX_STORAGE_TOKENS - currentTotal} available.`,
      );
    }
  }

  const result = await pool.query(
    `UPDATE memories
     SET header = $1, body = $2, tags = $3, token_count = $4, updated_at = now()
     WHERE id = $5
     RETURNING id, header, body, tags, session_id, token_count, created_at, updated_at`,
    [newHeader, newBody, newTags, newTokenCount, id],
  );

  return rowToMemory(result.rows[0]);
}

export async function deleteMemory(id: string): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM memories WHERE id = $1 RETURNING id",
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getMemoryStats(): Promise<MemoryStats> {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS total_memories, COALESCE(SUM(token_count), 0)::int AS total_tokens FROM memories",
  );
  const row = result.rows[0];
  return {
    totalMemories: row.total_memories as number,
    totalTokens: row.total_tokens as number,
    storageLimit: env.MEMORY_MAX_STORAGE_TOKENS,
  };
}
