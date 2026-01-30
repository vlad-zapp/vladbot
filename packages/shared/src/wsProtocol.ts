import type {
  ChatMessage,
  ChatRequest,
  MemoryCreateRequest,
  MemoryUpdateRequest,
  SSEEvent,
  ToolCall,
  ToolDefinition,
} from "./types.js";

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** Client → Server */
export interface WsRequest {
  seq: number;
  type: string;
  payload?: unknown;
}

/** Server → Client (response correlated by seq) */
export interface WsResponse {
  seq: number;
  ok: boolean;
  data?: unknown;
  error?: string;
  /** HTTP-equivalent status code for errors (400, 404, 409, 500, …) */
  status?: number;
}

/** Server → Client (unsolicited push) */
export interface WsPush {
  push: true;
  sessionId: string;
  event: SSEEvent;
}

// ---------------------------------------------------------------------------
// Method payloads & results
// ---------------------------------------------------------------------------

export interface WsMethods {
  // Config
  "config.init": { payload: { version: number; retryCount?: number }; result: { version: number } };
  "config.retries": { payload: { count: number }; result: {} };

  // Models & Tools
  "models.list": { payload: {}; result: unknown[] };
  "tools.list": { payload: {}; result: { definitions: unknown[] } };

  // Chat
  "chat.stream": {
    payload: ChatRequest & { sessionId?: string; assistantId?: string };
    result: {};
  };
  "chat.subscribe": {
    payload: { sessionId: string };
    result: { active: boolean };
  };
  "chat.tools.validate": {
    payload: { toolCalls: ToolCall[] };
    result: { errors: unknown[] };
  };
  "chat.tools.execute": {
    payload: { toolCalls: ToolCall[]; sessionId?: string };
    result: { results: unknown[] };
  };

  // Sessions
  "sessions.list": { payload: {}; result: unknown[] };
  "sessions.create": { payload: { title?: string }; result: unknown };
  "sessions.get": { payload: { id: string }; result: unknown };
  "sessions.update": { payload: { id: string; title: string }; result: unknown };
  "sessions.delete": { payload: { id: string }; result: {} };
  "sessions.lastActive.get": { payload: {}; result: { sessionId: string | null } };
  "sessions.lastActive.set": { payload: { sessionId: string }; result: {} };
  "sessions.compact": {
    payload: { sessionId: string; model: string; provider: string; contextWindow: number };
    result: { compactionMessage: ChatMessage; summary: string };
  };

  // Messages
  "messages.list": {
    payload: { sessionId: string; before?: number; limit?: number };
    result: { messages: ChatMessage[]; hasMore: boolean };
  };
  "messages.create": {
    payload: { sessionId: string } & ChatMessage;
    result: { ok: boolean; id: string; images?: string[]; tokenCount?: number };
  };
  "messages.update": {
    payload: {
      sessionId: string;
      messageId: string;
      toolResults?: unknown[];
      approvalStatus?: string;
    };
    result: {};
  };
  "messages.approve": {
    payload: {
      sessionId: string;
      messageId: string;
      model: string;
      provider: string;
      tools?: ToolDefinition[];
    };
    result: {};
  };
  "messages.deny": {
    payload: { sessionId: string; messageId: string };
    result: {};
  };

  // Memories
  "memories.list": {
    payload: { query?: string; tags?: string[]; limit?: number; offset?: number; order?: string };
    result: unknown;
  };
  "memories.stats": { payload: {}; result: unknown };
  "memories.get": { payload: { id: string }; result: unknown };
  "memories.create": { payload: MemoryCreateRequest; result: unknown };
  "memories.update": { payload: { id: string } & MemoryUpdateRequest; result: unknown };
  "memories.delete": { payload: { id: string }; result: {} };

  // Settings
  "settings.get": { payload: {}; result: { settings: Record<string, string> } };
  "settings.update": {
    payload: { settings: Record<string, string> };
    result: { settings: Record<string, string> };
  };
}

export type WsMethodType = keyof WsMethods;

/** Message types that must NOT be retried (they trigger side-effects). */
export const NON_RETRYABLE_TYPES: ReadonlySet<string> = new Set<WsMethodType>([
  "chat.stream",
  "chat.subscribe",
  "messages.approve",
]);

/** Maximum retry count a client can request. */
export const MAX_RETRY_COUNT = 10;

/** Default retry count when client doesn't specify. */
export const DEFAULT_RETRY_COUNT = 2;
