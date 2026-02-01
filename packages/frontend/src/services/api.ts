import type {
  AppSettings,
  ChatMessage,
  ClassifiedError,
  Memory,
  MemoryCreateRequest,
  MemoryListResponse,
  MemoryStats,
  MemoryUpdateRequest,
  ModelInfo,
  Session,
  SessionWithMessages,
  SSEEvent,
  ToolCall,
  ToolDefinition,
  ToolExecuteRequest,
  ToolExecuteResponse,
  ToolResult,
} from "@vladbot/shared";
import { wsClient } from "./wsClient.js";

export async function fetchModels(): Promise<ModelInfo[]> {
  return wsClient.request<ModelInfo[]>("models.list", {});
}

export async function fetchTools(): Promise<{
  definitions: ToolDefinition[];
}> {
  return wsClient.request<{ definitions: ToolDefinition[] }>("tools.list", {});
}

export async function validateTools(
  toolCalls: ToolCall[],
): Promise<ToolResult[]> {
  try {
    const data = await wsClient.request<{ errors: ToolResult[] }>(
      "chat.tools.validate",
      { toolCalls },
    );
    return data.errors ?? [];
  } catch {
    return [];
  }
}

export async function executeTools(
  request: ToolExecuteRequest & { sessionId?: string },
): Promise<ToolExecuteResponse> {
  return wsClient.request<ToolExecuteResponse>("chat.tools.execute", request);
}

// Session CRUD

export async function fetchSessions(): Promise<Session[]> {
  return wsClient.request<Session[]>("sessions.list", {});
}

export async function createSessionApi(title?: string): Promise<Session> {
  return wsClient.request<Session>("sessions.create", { title });
}

export async function fetchSession(id: string): Promise<SessionWithMessages> {
  return wsClient.request<SessionWithMessages>("sessions.get", { id });
}

export async function deleteSessionApi(id: string): Promise<void> {
  await wsClient.request("sessions.delete", { id });
}

export async function updateSessionTitleApi(
  id: string,
  title: string,
): Promise<Session> {
  return wsClient.request<Session>("sessions.update", { id, title });
}

export async function updateSessionAutoApproveApi(
  id: string,
  autoApprove: boolean,
): Promise<Session> {
  return wsClient.request<Session>("sessions.update", { id, autoApprove });
}

export function watchSessionApi(sessionId: string): Promise<void> {
  return wsClient.request("sessions.watch", { sessionId }).then(() => {});
}

export function unwatchSessionApi(sessionId: string): Promise<void> {
  return wsClient.request("sessions.unwatch", { sessionId }).then(() => {});
}

export async function saveMessage(
  sessionId: string,
  message: ChatMessage,
): Promise<{ id?: string; images?: string[]; tokenCount?: number }> {
  return wsClient.request<{ id?: string; images?: string[]; tokenCount?: number }>(
    "messages.create",
    { sessionId, ...message },
  );
}

export async function updateMessageApi(
  sessionId: string,
  messageId: string,
  updates: {
    content?: string;
    toolResults?: ChatMessage["toolResults"];
    approvalStatus?: ChatMessage["approvalStatus"];
  },
): Promise<void> {
  await wsClient.request("messages.update", { sessionId, messageId, ...updates });
}

// Paginated messages

export async function fetchMessages(
  sessionId: string,
  opts?: { before?: number; limit?: number },
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  return wsClient.request<{ messages: ChatMessage[]; hasMore: boolean }>(
    "messages.list",
    { sessionId, ...opts },
  );
}

// Streaming

export interface DebugEntry {
  timestamp: number;
  direction: "request" | "response";
  body: unknown;
  messageId?: string;
}

export interface SnapshotData {
  assistantId: string;
  content: string;
  model: string;
  toolCalls: ToolCall[];
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onToolCall: (toolCall: ToolCall) => void;
  onToolResult?: (result: ToolResult) => void;
  onDone: (hasToolCalls: boolean) => void;
  onError: (error: ClassifiedError) => void;
  onDebug?: (entry: DebugEntry) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  onAutoApproved?: (messageId: string) => void;
  onSnapshot?: (data: SnapshotData) => void;
  onCompaction?: (message: ChatMessage) => void;
}

/** Dispatch a push event to the appropriate stream callback. */
function dispatchStreamEvent(event: SSEEvent, callbacks: StreamCallbacks): void {
  switch (event.type) {
    case "token":
      callbacks.onToken(event.data);
      break;
    case "tool_call":
      callbacks.onToolCall(event.data);
      break;
    case "done":
      callbacks.onDone(event.data.hasToolCalls);
      break;
    case "error":
      callbacks.onError(event.data);
      break;
    case "debug":
      callbacks.onDebug?.({
        timestamp: Date.now(),
        direction: event.data.direction,
        body: event.data.body,
      });
      break;
    case "tool_result":
      callbacks.onToolResult?.(event.data);
      break;
    case "usage":
      callbacks.onUsage?.(event.data);
      break;
    case "auto_approved":
      callbacks.onAutoApproved?.(event.data.messageId);
      break;
    case "snapshot":
      callbacks.onSnapshot?.(event.data);
      break;
    case "compaction":
      callbacks.onCompaction?.(event.data);
      break;
  }
}

export async function streamChat(
  request: { sessionId: string; assistantId?: string },
  callbacks: StreamCallbacks,
): Promise<void> {
  const { sessionId } = request;

  return new Promise<void>((resolve) => {
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      unsub();
      unsubConn();
    };

    const unsub = wsClient.onPush(sessionId, (event: SSEEvent) => {
      if (finished) return;
      dispatchStreamEvent(event, callbacks);
      if (event.type === "done" || event.type === "error") {
        cleanup();
        resolve();
      }
    });

    const unsubConn = wsClient.onConnectionChange((connected) => {
      if (!connected && !finished) {
        cleanup();
        callbacks.onDone(false);
        resolve();
      }
    });

    wsClient.request("chat.stream", request).catch((err) => {
      cleanup();
      callbacks.onError({ message: err.message, code: "UNKNOWN", recoverable: false });
      resolve();
    });
  });
}

// Stream reconnection

export async function subscribeToStream(
  sessionId: string,
  callbacks: StreamCallbacks,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      unsub();
      unsubConn();
    };

    const unsub = wsClient.onPush(sessionId, (event: SSEEvent) => {
      if (finished) return;
      dispatchStreamEvent(event, callbacks);
      if (event.type === "done" || event.type === "error") {
        cleanup();
        resolve(true);
      }
    });

    const unsubConn = wsClient.onConnectionChange((connected) => {
      if (!connected && !finished) {
        cleanup();
        callbacks.onDone(false);
        resolve(true);
      }
    });

    wsClient.request<{ active: boolean }>("chat.subscribe", { sessionId })
      .then((result) => {
        if (!result.active) {
          cleanup();
          resolve(false);
        }
      })
      .catch(() => {
        cleanup();
        resolve(false);
      });
  });
}

// Compaction

export async function compactSessionApi(
  sessionId: string,
): Promise<void> {
  await wsClient.request("sessions.compact", { sessionId });
}

// Model switch compaction

export async function switchModelApi(
  sessionId: string,
  newModel: string,
): Promise<void> {
  await wsClient.request("sessions.switchModel", { sessionId, newModel });
}

// Memory CRUD

export async function fetchMemories(params?: {
  query?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
  order?: "newest" | "oldest";
}): Promise<MemoryListResponse> {
  return wsClient.request<MemoryListResponse>("memories.list", params ?? {});
}

export async function fetchMemory(id: string): Promise<Memory> {
  return wsClient.request<Memory>("memories.get", { id });
}

export async function createMemoryApi(
  data: MemoryCreateRequest,
): Promise<Memory> {
  return wsClient.request<Memory>("memories.create", data);
}

export async function updateMemoryApi(
  id: string,
  data: MemoryUpdateRequest,
): Promise<Memory> {
  return wsClient.request<Memory>("memories.update", { id, ...data });
}

export async function deleteMemoryApi(id: string): Promise<void> {
  await wsClient.request("memories.delete", { id });
}

export async function fetchMemoryStats(): Promise<MemoryStats> {
  return wsClient.request<MemoryStats>("memories.stats", {});
}

// Settings

export async function fetchSettings(): Promise<AppSettings> {
  const data = await wsClient.request<{ settings: AppSettings }>("settings.get", {});
  return data.settings;
}

export async function updateSettings(
  settings: Partial<AppSettings>,
): Promise<AppSettings> {
  const data = await wsClient.request<{ settings: AppSettings }>(
    "settings.update",
    { settings },
  );
  return data.settings;
}

// Server-side tool approval

export async function approveToolCallsApi(
  sessionId: string,
  messageId: string,
): Promise<void> {
  await wsClient.request("messages.approve", {
    sessionId,
    messageId,
  });
}

export async function denyToolCallsApi(
  sessionId: string,
  messageId: string,
): Promise<void> {
  await wsClient.request("messages.deny", { sessionId, messageId });
}

// Last active session persistence

export async function fetchLastActiveSession(): Promise<string | null> {
  try {
    const data = await wsClient.request<{ sessionId: string | null }>(
      "sessions.lastActive.get",
      {},
    );
    return data.sessionId ?? null;
  } catch {
    return null;
  }
}

export async function saveLastActiveSession(sessionId: string): Promise<void> {
  try {
    await wsClient.request("sessions.lastActive.set", { sessionId });
  } catch {
    // Fire-and-forget: mirror original behavior of not checking response
  }
}
