import type { Tool } from "./ToolExecutor.js";
import { buildOperationToolDef } from "./buildToolDef.js";
import type { JsonSchemaProperty } from "@vladbot/shared";
import {
  searchSessionMessages,
  searchAllMessages,
} from "../sessionStore.js";

const MAX_CONTENT_PER_MSG = 2000;
const MAX_TOTAL_CONTENT = 50_000;

const P = {
  query: {
    type: "string",
    description:
      "Full-text search query. Supports natural language (e.g. 'VNC password' or 'docker config').",
  },
  role: {
    type: "string",
    description: "Filter by message role.",
    enum: ["user", "assistant", "tool", "compaction"],
  },
  limit: {
    type: "number",
    description: "Max results to return (default 20, max 50).",
  },
  offset: {
    type: "number",
    description: "Pagination offset (default 0).",
  },
} satisfies Record<string, JsonSchemaProperty>;

export const chatHistoryTool: Tool = {
  definition: buildOperationToolDef({
    name: "chat_history",
    description: `Search past chat messages by full-text query. Useful for finding specific details from earlier in the conversation that may have been summarized away by context compaction.

Supported operations:
- search_current: Search messages in the CURRENT session. Use this when you need to recall details from earlier in this conversation (e.g. specific values, commands, outputs, or decisions that were compacted).
- search_all: Search messages across ALL OTHER sessions. ONLY use this when the user explicitly asks you to find something from a previous/different conversation. Never use this proactively.`,
    params: P,
    operations: {
      search_current: {
        params: ["query", "role", "limit", "offset"],
        required: ["query"],
      },
      search_all: {
        params: ["query", "role", "limit", "offset"],
        required: ["query"],
      },
    },
  }),

  async execute(
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<string> {
    const op = args.operation as string;
    switch (op) {
      case "search_current":
        return handleSearchCurrent(args, sessionId);
      case "search_all":
        return handleSearchAll(args, sessionId);
      default:
        throw new Error(`Unknown chat_history operation: ${op}`);
    }
  },
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "... [truncated]";
}

interface MessageOutput {
  role: string;
  content: string;
  timestamp: number;
  time: string;
  session_title?: string;
}

async function handleSearchCurrent(
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<string> {
  if (!sessionId) {
    return JSON.stringify({ error: "No active session." });
  }

  const query = args.query as string;
  if (!query) {
    return JSON.stringify({ error: "query is required." });
  }

  const { messages, total } = await searchSessionMessages({
    sessionId,
    query,
    role: (args.role as string) || undefined,
    limit: args.limit != null ? Number(args.limit) : undefined,
    offset: args.offset != null ? Number(args.offset) : undefined,
  });

  let totalChars = 0;
  const output: MessageOutput[] = [];

  for (const msg of messages) {
    const content = truncate(msg.content, MAX_CONTENT_PER_MSG);
    if (totalChars + content.length > MAX_TOTAL_CONTENT) break;
    totalChars += content.length;
    output.push({
      role: msg.role,
      content,
      timestamp: msg.timestamp,
      time: new Date(msg.timestamp).toISOString(),
    });
  }

  return JSON.stringify({ count: output.length, total, messages: output });
}

async function handleSearchAll(
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<string> {
  const query = args.query as string;
  if (!query) {
    return JSON.stringify({ error: "query is required." });
  }

  const { messages, total } = await searchAllMessages({
    query,
    excludeSessionId: sessionId || undefined,
    role: (args.role as string) || undefined,
    limit: args.limit != null ? Number(args.limit) : undefined,
    offset: args.offset != null ? Number(args.offset) : undefined,
  });

  let totalChars = 0;
  const output: MessageOutput[] = [];

  for (const msg of messages) {
    const content = truncate(msg.content, MAX_CONTENT_PER_MSG);
    if (totalChars + content.length > MAX_TOTAL_CONTENT) break;
    totalChars += content.length;
    output.push({
      role: msg.role,
      content,
      timestamp: msg.timestamp,
      time: new Date(msg.timestamp).toISOString(),
      session_title: (msg as unknown as { sessionTitle: string }).sessionTitle,
    });
  }

  return JSON.stringify({ count: output.length, total, messages: output });
}
