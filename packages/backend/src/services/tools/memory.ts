import type { Tool } from "./ToolExecutor.js";
import { buildOperationToolDef } from "./buildToolDef.js";
import type { JsonSchemaProperty } from "@vladbot/shared";
import {
  searchMemories,
  listMemories,
  getMemory,
  createMemory,
  updateMemory,
  deleteMemory,
  getMemoryStats,
} from "../memoryStore.js";
import { env } from "../../config/env.js";

const P = {
  id:         { type: "string", description: "Memory ID (UUID)." },
  header:     { type: "string", description: "Brief title/description of the memory." },
  text:       { type: "string", description: "Full body content of the memory." },
  tags:       { type: "array", description: "Categorization tags.", items: { type: "string" } },
  query:      { type: "string", description: "Full-text search query. Supports natural language." },
  session_id: { type: "string", description: "Session ID to scope the memory. Omit for global." },
  date_from:  { type: "string", description: "ISO datetime — inclusive start." },
  date_to:    { type: "string", description: "ISO datetime — inclusive end." },
  limit:      { type: "number", description: "Max results (default 20, max 100)." },
  offset:     { type: "number", description: "Pagination offset (default 0)." },
  order:      { type: "string", description: "Sort: 'newest' or 'oldest' (default 'newest').", enum: ["newest", "oldest"] },
} satisfies Record<string, JsonSchemaProperty>;

export const memoryTool: Tool = {
  definition: buildOperationToolDef({
    name: "memory",
    description: `Manage persistent memory entries. Use this tool to save and recall information across conversations.

BEHAVIOR GUIDELINES:
- ALWAYS search memory before answering questions about specific facts, preferences, credentials, configurations, or anything the user may have told you before. Never say "I don't know" or guess without checking memory first.
- When connecting to any service (VNC, SSH, etc.), ALWAYS search memory for credentials, hostnames, and connection details before attempting anonymous or passwordless access.
- Save a memory when the user explicitly asks you to remember something.
- Save proactively ONLY when you encounter truly important information: user preferences, credentials, key decisions, critical facts, project context that will be needed later. Do NOT save trivial or ephemeral information.
- Search memory at the start of conversations or when context from past interactions would be helpful.
- Use specific, descriptive tags to categorize memories for easy retrieval later (e.g. "credentials", "vnc", "preference").
- When searching, start with specific criteria. If no results, broaden your search.

Supported operations:
- save: Create a new memory entry
- search: Find memories by full-text search, tags, date range, or session scope
- list: List memory entries with pagination (headers and metadata only)
- delete: Remove a memory by ID
- update: Modify an existing memory`,
    params: P,
    operations: {
      save:   { params: ["header", "text", "tags", "session_id"], required: ["header", "text"] },
      search: { params: ["query", "tags", "date_from", "date_to", "session_id", "limit", "offset"] },
      list:   { params: ["tags", "session_id", "limit", "offset", "order"] },
      delete: { params: ["id"], required: ["id"] },
      update: { params: ["id", "header", "text", "tags"], required: ["id"] },
    },
  }),

  async execute(args: Record<string, unknown>): Promise<string> {
    const op = args.operation as string;
    switch (op) {
      case "save":
        return handleSave(args);
      case "search":
        return handleSearch(args);
      case "list":
        return handleList(args);
      case "delete":
        return handleDelete(args);
      case "update":
        return handleUpdate(args);
      default:
        throw new Error(`Unknown memory operation: ${op}`);
    }
  },
};

function requireArg(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (val === undefined || val === null || val === "") {
    throw new Error(`Missing required argument: ${key}`);
  }
  return String(val);
}

async function handleSave(args: Record<string, unknown>): Promise<string> {
  const header = requireArg(args, "header");
  const text = requireArg(args, "text");
  const tags = (args.tags as string[]) || [];
  const sessionId = (args.session_id as string) || undefined;

  try {
    const memory = await createMemory({ header, body: text, tags, sessionId });
    const stats = await getMemoryStats();
    return JSON.stringify({
      status: "saved",
      id: memory.id,
      header: memory.header,
      tags: memory.tags,
      token_count: memory.tokenCount,
      created_at: memory.createdAt,
      storage_used: stats.totalTokens,
      storage_limit: stats.storageLimit,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("storage limit")) {
      return JSON.stringify({ status: "error", message: err.message });
    }
    throw err;
  }
}

async function handleSearch(args: Record<string, unknown>): Promise<string> {
  const query = args.query as string | undefined;
  const tags = args.tags as string[] | undefined;
  const dateFrom = args.date_from as string | undefined;
  const dateTo = args.date_to as string | undefined;
  const sessionId = args.session_id as string | undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  const offset = Math.max(Number(args.offset) || 0, 0);

  const results = await searchMemories({
    query,
    tags,
    dateFrom,
    dateTo,
    sessionId,
    limit,
    offset,
  });

  // Apply token truncation for AI context
  let totalReturnTokens = 0;
  const memories: unknown[] = [];
  let truncated = false;

  for (const mem of results) {
    if (totalReturnTokens + mem.tokenCount > env.MEMORY_MAX_RETURN_TOKENS) {
      truncated = true;
      break;
    }
    totalReturnTokens += mem.tokenCount;
    memories.push({
      id: mem.id,
      header: mem.header,
      body: mem.body,
      tags: mem.tags,
      session_id: mem.sessionId,
      created_at: mem.createdAt,
      updated_at: mem.updatedAt,
    });
  }

  const response: Record<string, unknown> = {
    count: memories.length,
    total_fetched: results.length,
    memories,
  };

  if (truncated) {
    response.truncated = true;
    response.message =
      "Output truncated because search results exceeded the maximum return token limit. " +
      "Please narrow your search criteria by using more specific tags, text query, or date range.";
  }

  return JSON.stringify(response);
}

async function handleList(args: Record<string, unknown>): Promise<string> {
  const tags = args.tags as string[] | undefined;
  const sessionId = args.session_id as string | undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  const offset = Math.max(Number(args.offset) || 0, 0);
  const order = (args.order as string) === "oldest" ? "oldest" as const : "newest" as const;

  // For the tool's list, we use searchMemories to get full Memory objects
  // so we can apply token truncation, but we only return headers (no body).
  // We pass sessionId through the search function for proper filtering.
  const results = await searchMemories({
    tags,
    sessionId,
    limit,
    offset,
  });

  // Also get total count via listMemories
  const listResult = await listMemories({
    tags,
    limit: 1,
    offset: 0,
    order,
  });

  let totalReturnTokens = 0;
  const items: unknown[] = [];
  let truncated = false;

  for (const mem of results) {
    if (totalReturnTokens + mem.tokenCount > env.MEMORY_MAX_RETURN_TOKENS) {
      truncated = true;
      break;
    }
    totalReturnTokens += mem.tokenCount;
    items.push({
      id: mem.id,
      header: mem.header,
      tags: mem.tags,
      session_id: mem.sessionId,
      token_count: mem.tokenCount,
      created_at: mem.createdAt,
      updated_at: mem.updatedAt,
    });
  }

  const response: Record<string, unknown> = {
    count: items.length,
    total: listResult.total,
    memories: items,
  };

  if (truncated) {
    response.truncated = true;
    response.message =
      "List truncated because results exceeded the maximum return token limit. " +
      "Use more specific tags or narrower filters.";
  }

  return JSON.stringify(response);
}

async function handleDelete(args: Record<string, unknown>): Promise<string> {
  const id = requireArg(args, "id");

  // Get the memory first so we can return its header
  const memory = await getMemory(id);
  if (!memory) {
    return JSON.stringify({ status: "error", message: `Memory not found: ${id}` });
  }

  await deleteMemory(id);

  return JSON.stringify({
    status: "deleted",
    id: memory.id,
    header: memory.header,
  });
}

async function handleUpdate(args: Record<string, unknown>): Promise<string> {
  const id = requireArg(args, "id");
  const header = args.header as string | undefined;
  const text = args.text as string | undefined;
  const tags = args.tags as string[] | undefined;

  if (!header && !text && !tags) {
    return JSON.stringify({
      status: "error",
      message: "No fields to update. Provide at least one of: header, text, tags.",
    });
  }

  try {
    const memory = await updateMemory(id, {
      header,
      body: text,
      tags,
    });

    if (!memory) {
      return JSON.stringify({ status: "error", message: `Memory not found: ${id}` });
    }

    return JSON.stringify({
      status: "updated",
      id: memory.id,
      header: memory.header,
      tags: memory.tags,
      token_count: memory.tokenCount,
      created_at: memory.createdAt,
      updated_at: memory.updatedAt,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("storage limit")) {
      return JSON.stringify({ status: "error", message: err.message });
    }
    throw err;
  }
}
