import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChatMessage, ModelInfo, SSEEvent } from "@vladbot/shared";
import { AVAILABLE_MODELS, findModel, formatModelField } from "@vladbot/shared";
import { registerHandler, watchSession, unwatchSession, getSessionWatchers, broadcastToAllClients } from "./wsServer.js";
import { env } from "../config/env.js";
import {
  createSession,
  listSessions,
  getSession,
  getMessages,
  updateSessionTitle,
  updateSession,
  getSessionAutoApprove,
  getSessionModel,
  deleteSession,
  addMessage,
  updateMessage,
  atomicApprove,
  updateSessionTokenUsage,
} from "../services/sessionStore.js";
import { saveSessionFile } from "../services/sessionFiles.js";
import { compactSession } from "../services/compaction.js";
import {
  createStream,
  getStream,
  pushEvent,
  scheduleRemoval,
} from "../services/streamRegistry.js";
import { executeToolRound, denyToolRound, buildHistoryFromDB } from "../services/toolLoop.js";
import { getToolDefinitions, executeToolCalls, validateToolCalls } from "../services/tools/index.js";
import { estimateMessageTokens } from "../services/tokenCounter.js";
import { getSetting, putSettings } from "../services/settingsStore.js";
import { getAllRuntimeSettings } from "../config/runtimeSettings.js";
import { getProvider } from "../services/ai/ProviderFactory.js";
import { classifyLLMError } from "../services/ai/errorClassifier.js";
import { autoCompactIfNeeded } from "../services/autoCompact.js";
import { generateSessionName } from "../services/sessionNaming.js";
import {
  chatRequestSchema,
  toolExecuteSchema,
} from "../routes/schemas.js";

// ---------------------------------------------------------------------------
// Error helper — includes HTTP-equivalent status code
// ---------------------------------------------------------------------------

class WsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Tool status computation
// ---------------------------------------------------------------------------

type ToolCallStatus = "pending" | "executing" | "done" | "cancelled" | "waiting";

function computeToolStatuses(message: ChatMessage): Record<string, ToolCallStatus> | undefined {
  if (!message.toolCalls?.length) return undefined;

  const results = message.toolResults ?? [];
  const status = message.approvalStatus;
  const statuses: Record<string, ToolCallStatus> = {};

  for (let i = 0; i < message.toolCalls.length; i++) {
    const tc = message.toolCalls[i];
    const result = results.find((r) => r.toolCallId === tc.id);

    if (result) {
      statuses[tc.id] = "done";
    } else if (status === "pending" && results.length === 0) {
      statuses[tc.id] = "pending";
    } else if (status === "denied") {
      statuses[tc.id] = "cancelled";
    } else {
      // Approved — check if a previous tool errored
      const prevErrored = results.some((r) => r.isError);
      if (prevErrored) {
        statuses[tc.id] = "cancelled";
      } else if (i === results.length) {
        statuses[tc.id] = "executing";
      } else {
        statuses[tc.id] = "waiting";
      }
    }
  }

  return statuses;
}

// ---------------------------------------------------------------------------
// Models & Tools
// ---------------------------------------------------------------------------

const providerKeyMap: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GOOGLE_GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/**
 * Resolve the model for a session from the DB.
 * Legacy sessions (NULL model) are lazy-migrated to the default model.
 * Model field uses "provider:modelId" format.
 */
async function resolveSessionModel(sessionId: string): Promise<ModelInfo> {
  const storedModel = await getSessionModel(sessionId);
  if (storedModel === null) throw new WsError(404, "Session not found");

  if (storedModel) {
    const modelInfo = findModel(storedModel);
    if (modelInfo) return modelInfo;
  }

  // Legacy session or unknown model — fall back to default_model setting
  const defaultModelSetting = await getSetting("default_model");
  const defaultModel =
    (defaultModelSetting && findModel(defaultModelSetting)) ||
    AVAILABLE_MODELS[0];

  // Lazy-migrate
  await updateSession(sessionId, { model: formatModelField(defaultModel) });

  return defaultModel;
}

registerHandler("models.list", async () => {
  return AVAILABLE_MODELS.filter((m) => {
    const key = providerKeyMap[m.provider];
    return key ? !!env[key as keyof typeof env] : false;
  });
});

registerHandler("tools.list", async () => {
  return { definitions: getToolDefinitions() };
});

registerHandler("chat.tools.validate", async (payload) => {
  const parsed = toolExecuteSchema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  const errors = validateToolCalls(parsed.data.toolCalls);
  return { errors };
});

registerHandler("chat.tools.execute", async (payload) => {
  const parsed = toolExecuteSchema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  const results = await executeToolCalls(parsed.data.toolCalls, parsed.data.sessionId);
  return { results };
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

registerHandler("sessions.list", async () => {
  return await listSessions();
});

registerHandler("sessions.create", async (payload, ctx) => {
  const schema = z.object({ title: z.string().optional(), model: z.string().optional() });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));

  // Resolve model: explicit param > default_model setting > first available
  let modelInfo: ModelInfo | undefined;
  if (parsed.data.model) {
    modelInfo = findModel(parsed.data.model);
  }
  if (!modelInfo) {
    const defaultModelSetting = await getSetting("default_model");
    modelInfo =
      (defaultModelSetting && findModel(defaultModelSetting)) ||
      AVAILABLE_MODELS[0];
  }

  const visionModel = await getSetting("vision_model") ?? "";
  const session = await createSession(parsed.data.title, formatModelField(modelInfo), visionModel);
  ctx.broadcastGlobal("__sessions__", { type: "session_created", data: session });
  return session;
});

registerHandler("sessions.get", async (payload) => {
  const schema = z.object({ id: z.string().min(1) });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  const session = await getSession(parsed.data.id);
  if (!session) throw new WsError(404, "Session not found");
  return session;
});

registerHandler("sessions.update", async (payload, ctx) => {
  const schema = z.object({
    id: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    autoApprove: z.boolean().optional(),
    visionModel: z.string().optional(),
  }).refine((d) => d.title !== undefined || d.autoApprove !== undefined || d.visionModel !== undefined, {
    message: "At least one of title, autoApprove, or visionModel must be provided",
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  const session = await updateSession(parsed.data.id, {
    title: parsed.data.title,
    autoApprove: parsed.data.autoApprove,
    visionModel: parsed.data.visionModel,
  });
  if (!session) throw new WsError(404, "Session not found");
  // Broadcast to ALL clients including sender
  const sessionEvent = { type: "session_updated" as const, data: session };
  ctx.push("__sessions__", sessionEvent);
  ctx.broadcastGlobal("__sessions__", sessionEvent);
  return session;
});

registerHandler("sessions.delete", async (payload, ctx) => {
  const schema = z.object({ id: z.string().min(1) });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  const deleted = await deleteSession(parsed.data.id);
  if (!deleted) throw new WsError(404, "Session not found");
  ctx.broadcastGlobal("__sessions__", { type: "session_deleted", data: { id: parsed.data.id } });
  return {};
});

registerHandler("sessions.watch", async (payload, ctx) => {
  const schema = z.object({ sessionId: z.string().min(1) });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));

  const { sessionId } = parsed.data;
  watchSession(ctx.ws, sessionId);

  // If there's an active stream for this session, auto-subscribe
  const stream = getStream(sessionId);
  if (stream && !stream.done) {
    const subscriber = (event: SSEEvent) => {
      ctx.push(sessionId, event);
    };
    stream.subscribers.add(subscriber);
    ctx.addSubscription(sessionId, subscriber);

    // Send snapshot so this client can pick up the in-progress stream
    ctx.push(sessionId, {
      type: "snapshot",
      data: {
        assistantId: stream.assistantId,
        content: stream.content,
        model: stream.model,
        toolCalls: stream.toolCalls,
      },
    });
  }

  return {};
});

registerHandler("sessions.unwatch", async (payload, ctx) => {
  const schema = z.object({ sessionId: z.string().min(1) });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  unwatchSession(ctx.ws, parsed.data.sessionId);
  return {};
});

registerHandler("sessions.lastActive.get", async () => {
  const sessionId = await getSetting("last_active_session_id");
  return { sessionId: sessionId ?? null };
});

registerHandler("sessions.lastActive.set", async (payload) => {
  const schema = z.object({ sessionId: z.string().min(1) });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  await putSettings({ last_active_session_id: parsed.data.sessionId });
  return {};
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

registerHandler("messages.list", async (payload) => {
  const schema = z.object({
    sessionId: z.string().min(1),
    before: z.number().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  const result = await getMessages(parsed.data.sessionId, {
    before: parsed.data.before,
    limit: parsed.data.limit,
  });

  // Compute tool statuses for assistant messages with tool calls
  const messages = result.messages.map((m) => {
    if (m.role !== "assistant" || !m.toolCalls?.length) return m;
    return { ...m, toolStatuses: computeToolStatuses(m) };
  });

  return { messages, hasMore: result.hasMore };
});

registerHandler("messages.create", async (payload, ctx) => {
  const schema = z.object({
    sessionId: z.string().min(1),
    id: z.string().optional(),
    role: z.enum(["user", "assistant", "tool", "compaction"]),
    content: z.string(),
    images: z.array(z.string()).optional(),
    model: z.string().optional(),
    timestamp: z.number(),
    toolCalls: z.array(z.any()).optional(),
    toolResults: z.array(z.any()).optional(),
    approvalStatus: z.enum(["pending", "approved", "denied"]).optional(),
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));

  const { sessionId, ...msgData } = parsed.data;
  const session = await getSession(sessionId);
  if (!session) throw new WsError(404, "Session not found");

  const message = msgData as ChatMessage;

  // Convert data-URI images to session files
  if (message.images?.length) {
    const urls: string[] = [];
    for (const img of message.images) {
      const match = img.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (match) {
        const ext = match[1].split("/")[1] || "jpg";
        const buf = Buffer.from(match[2], "base64");
        const filename = saveSessionFile(sessionId, buf, ext);
        urls.push(`/api/sessions/${sessionId}/files/${filename}`);
      } else {
        urls.push(img);
      }
    }
    message.images = urls;
  }

  message.tokenCount = estimateMessageTokens(message);
  const dbId = await addMessage(sessionId, message);
  message.id = dbId;

  // Notify other clients watching this session
  ctx.broadcastToSession(sessionId, { type: "new_message", data: message });

  return { ok: true, id: dbId, images: message.images, tokenCount: message.tokenCount };
});

registerHandler("messages.interrupt", async (payload) => {
  const schema = z.object({
    sessionId: z.string().min(1),
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));

  const { sessionId } = parsed.data;
  const stream = getStream(sessionId);
  if (stream) {
    // Abort the LLM stream immediately
    stream.abortController.abort();

    // Mark stream as aborted so no further tokens are accumulated
    stream.aborted = true;

    // Append interrupted message to the stream content
    const interruptText = "\n\n[Interrupted by user]";
    stream.content += interruptText;

    // Push the interrupted message as a token event so frontend displays it
    pushEvent(sessionId, { type: "token", data: interruptText });
  }
  return {};
});

registerHandler("messages.update", async (payload) => {
  const schema = z.object({
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    content: z.string().optional(),
    toolResults: z.array(z.any()).optional(),
    approvalStatus: z.enum(["pending", "approved", "denied"]).optional(),
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));

  const session = await getSession(parsed.data.sessionId);
  if (!session) throw new WsError(404, "Session not found");

  await updateMessage(parsed.data.messageId, {
    content: parsed.data.content,
    toolResults: parsed.data.toolResults,
    approvalStatus: parsed.data.approvalStatus,
  });
  return {};
});

registerHandler("messages.approve", async (payload, ctx) => {
  const schema = z.object({
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));

  const { sessionId, messageId } = parsed.data;

  const modelInfo = await resolveSessionModel(sessionId);
  const model = modelInfo.id;
  const tools = getToolDefinitions();

  const session = await getSession(sessionId);
  if (!session) throw new WsError(404, "Session not found");

  const message = session.messages.find((m) => m.id === messageId);
  if (!message) throw new WsError(404, "Message not found");

  if (message.approvalStatus !== "pending") {
    throw new WsError(409, `Message approval status is '${message.approvalStatus}', expected 'pending'`);
  }

  const updated = await atomicApprove(messageId);
  if (!updated) throw new WsError(409, "Message was already approved by a concurrent request");

  // Notify all other watchers that this message was approved
  ctx.broadcastToSession(sessionId, {
    type: "approval_changed",
    data: { messageId, approvalStatus: "approved" },
  });

  // Create a fresh stream and register this WS as subscriber
  const stream = createStream(sessionId, messageId, model);
  const subscriber = (event: SSEEvent) => {
    ctx.push(sessionId, event);
  };
  stream.subscribers.add(subscriber);
  ctx.addSubscription(sessionId, subscriber);

  // Subscribe all other session watchers so they see tool execution live
  for (const watcher of getSessionWatchers(sessionId)) {
    if (watcher.ws === ctx.ws) continue; // Skip the approving client
    const watcherSub = (event: SSEEvent) => {
      watcher.push(sessionId, event);
    };
    stream.subscribers.add(watcherSub);
    watcher.addSubscription(sessionId, watcherSub);

    // Notify watcher that approval happened + stream started
    watcher.push(sessionId, {
      type: "snapshot",
      data: { assistantId: messageId, content: stream.content, model, toolCalls: stream.toolCalls },
    });
  }

  // Execute tools in background (non-blocking)
  executeToolRound(
    sessionId,
    messageId,
    model,
    modelInfo.provider,
    tools,
  ).catch((err) => {
    console.error("Tool execution failed:", err);
  });

  return {};
});

registerHandler("messages.deny", async (payload, ctx) => {
  const schema = z.object({
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));

  const { sessionId, messageId } = parsed.data;
  const session = await getSession(sessionId);
  if (!session) throw new WsError(404, "Session not found");

  const message = session.messages.find((m) => m.id === messageId);
  if (!message) throw new WsError(404, "Message not found");

  if (message.approvalStatus !== "pending") {
    throw new WsError(409, `Message approval status is '${message.approvalStatus}', expected 'pending'`);
  }

  await denyToolRound(sessionId, messageId);

  // Notify other clients watching this session
  ctx.broadcastToSession(sessionId, {
    type: "approval_changed",
    data: { messageId, approvalStatus: "denied" },
  });

  return {};
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

registerHandler("sessions.compact", async (payload, ctx) => {
  const schema = z.object({
    sessionId: z.string().min(1),
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));

  const { sessionId } = parsed.data;
  const modelInfo = await resolveSessionModel(sessionId);

  // Notify ALL clients: compaction started
  const startEvent = { type: "compaction_started" as const, data: { sessionId } };
  ctx.push(sessionId, startEvent);
  ctx.broadcastToSession(sessionId, startEvent);

  // Run compaction in background, return ACK immediately
  (async () => {
    try {
      const result = await compactSession(
        sessionId,
        modelInfo.id,
        modelInfo.provider,
        modelInfo.contextWindow,
      );
      const doneEvent = { type: "compaction" as const, data: result.compactionMessage };
      ctx.push(sessionId, doneEvent);
      ctx.broadcastToSession(sessionId, doneEvent);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Compaction failed";
      console.error("Manual compaction failed:", err);
      const errorEvent = { type: "compaction_error" as const, data: { sessionId, error: message } };
      ctx.push(sessionId, errorEvent);
      ctx.broadcastToSession(sessionId, errorEvent);
    }
  })().catch(console.error);

  return {};
});

registerHandler("sessions.switchModel", async (payload, ctx) => {
  const schema = z.object({
    sessionId: z.string().min(1),
    newModel: z.string().min(1),
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));

  const { sessionId, newModel } = parsed.data;
  const newModelInfo = findModel(newModel);
  if (!newModelInfo) throw new WsError(400, "Unknown model");

  // Resolve the current (old) model before switching — used for summarization
  // if compaction is needed (the old model has a larger context window).
  const oldModelInfo = await resolveSessionModel(sessionId);

  // Persist model on the session.
  // If the new model has native vision, auto-clear the session's vision override.
  const sessionUpdates: { model: string; visionModel?: string } = {
    model: formatModelField(newModelInfo),
  };
  if (newModelInfo.nativeVision) {
    sessionUpdates.visionModel = "";
  }
  const updatedSession = await updateSession(sessionId, sessionUpdates);
  if (!updatedSession) throw new WsError(404, "Session not found");

  // Broadcast so ALL clients see the new model (including sender)
  const sessionEvent = { type: "session_updated" as const, data: updatedSession };
  ctx.push("__sessions__", sessionEvent);
  ctx.broadcastGlobal("__sessions__", sessionEvent);

  // Check if context exceeds 80% of new model's window → auto-compact
  const session = await getSession(sessionId);
  if (!session?.tokenUsage || newModelInfo.contextWindow <= 0) {
    return { compacted: false };
  }

  const pct = (session.tokenUsage.inputTokens / newModelInfo.contextWindow) * 100;
  if (pct < 80) {
    return { compacted: false };
  }

  // Notify ALL clients: compaction started
  const startEvent = { type: "compaction_started" as const, data: { sessionId } };
  ctx.push(sessionId, startEvent);
  ctx.broadcastToSession(sessionId, startEvent);

  try {
    // Use the OLD model for summarization (it has a larger context window and
    // can handle the full conversation), but the NEW model's context window
    // for the verbatim tail budget (that's the target context we're compacting for).
    const result = await compactSession(
      sessionId,
      oldModelInfo.id,
      oldModelInfo.provider,
      newModelInfo.contextWindow,
    );
    const doneEvent = { type: "compaction" as const, data: result.compactionMessage };
    ctx.push(sessionId, doneEvent);
    ctx.broadcastToSession(sessionId, doneEvent);
    return { compacted: true, compactionMessage: result.compactionMessage };
  } catch (err) {
    console.error("Model-switch compaction failed:", err);
    const message = err instanceof Error ? err.message : "Compaction failed";
    const errorEvent = { type: "compaction_error" as const, data: { sessionId, error: message } };
    ctx.push(sessionId, errorEvent);
    ctx.broadcastToSession(sessionId, errorEvent);
    return { compacted: false };
  }
});

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

registerHandler("memories.list", async (payload) => {
  const schema = z.object({
    query: z.string().optional(),
    tags: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
    order: z.enum(["newest", "oldest"]).optional(),
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  return await listMemories(parsed.data);
});

registerHandler("memories.stats", async () => {
  return await getMemoryStats();
});

registerHandler("memories.get", async (payload) => {
  const schema = z.object({ id: z.string().min(1) });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  const memory = await getMemory(parsed.data.id);
  if (!memory) throw new WsError(404, "Memory not found");
  return memory;
});

registerHandler("memories.create", async (payload, ctx) => {
  const schema = z.object({
    header: z.string().min(1).max(500),
    body: z.string().min(1),
    tags: z.array(z.string()).optional().default([]),
    sessionId: z.string().uuid().optional(),
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  try {
    const memory = await createMemory(parsed.data);
    ctx.broadcastGlobal("__memories__", { type: "memory_changed", data: {} });
    return memory;
  } catch (err) {
    if (err instanceof Error && err.message.includes("storage limit")) {
      throw new WsError(409, err.message);
    }
    throw err;
  }
});

registerHandler("memories.update", async (payload, ctx) => {
  const schema = z.object({
    id: z.string().min(1),
    header: z.string().min(1).max(500).optional(),
    body: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
  }).refine((data) => data.header || data.body || data.tags, {
    message: "At least one field must be provided: header, body, or tags",
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  try {
    const { id, ...updates } = parsed.data;
    const memory = await updateMemory(id, updates);
    if (!memory) throw new WsError(404, "Memory not found");
    ctx.broadcastGlobal("__memories__", { type: "memory_changed", data: {} });
    return memory;
  } catch (err) {
    if (err instanceof Error && err.message.includes("storage limit")) {
      throw new WsError(409, err.message);
    }
    throw err;
  }
});

registerHandler("memories.delete", async (payload, ctx) => {
  const schema = z.object({ id: z.string().min(1) });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  const deleted = await deleteMemory(parsed.data.id);
  if (!deleted) throw new WsError(404, "Memory not found");
  ctx.broadcastGlobal("__memories__", { type: "memory_changed", data: {} });
  return {};
});

// Memory imports (lazy to keep imports near usage)
import {
  listMemories,
  getMemory,
  createMemory,
  updateMemory,
  deleteMemory,
  getMemoryStats,
} from "../services/memoryStore.js";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

registerHandler("settings.get", async () => {
  const settings = await getAllRuntimeSettings();
  return { settings };
});

registerHandler("settings.update", async (payload, ctx) => {
  const schema = z.object({ settings: z.record(z.string()) });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));
  await putSettings(parsed.data.settings);
  const updated = await getAllRuntimeSettings();

  // Notify all other clients about the settings change
  ctx.broadcastGlobal("__settings__", { type: "settings_changed", data: updated });

  return { settings: updated };
});

// ---------------------------------------------------------------------------
// Streaming: chat.stream
// ---------------------------------------------------------------------------

registerHandler("chat.stream", async (payload, ctx) => {
  const parsed = chatRequestSchema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));

  const { sessionId } = parsed.data;
  const assistantId = parsed.data.assistantId ?? randomUUID();

  // Resolve model/provider/tools from the session (server is source of truth)
  const modelInfo = await resolveSessionModel(sessionId);
  const model = modelInfo.id;
  const providerName = modelInfo.provider;
  const tools = getToolDefinitions();

  // Register stream in the registry
  createStream(sessionId, assistantId, model);

  // Register this WS connection as a subscriber
  const stream = getStream(sessionId);
  if (stream) {
    const subscriber = (event: SSEEvent) => {
      ctx.push(sessionId, event);
    };
    stream.subscribers.add(subscriber);
    ctx.addSubscription(sessionId, subscriber);

    // Send snapshot to the initiating client so it knows the assistantId
    ctx.push(sessionId, {
      type: "snapshot",
      data: { assistantId, content: "", model, toolCalls: [] },
    });

    // Auto-subscribe all other session watchers so they see the stream live
    for (const watcher of getSessionWatchers(sessionId)) {
      if (watcher.ws === ctx.ws) continue; // Skip the initiating client
      const watcherSub = (event: SSEEvent) => {
        watcher.push(sessionId, event);
      };
      stream.subscribers.add(watcherSub);
      watcher.addSubscription(sessionId, watcherSub);

      // Send snapshot so watcher's client picks up the stream immediately
      watcher.push(sessionId, {
        type: "snapshot",
        data: { assistantId, content: "", model, toolCalls: [] },
      });
    }
  }

  // Run streaming in background — return ACK immediately
  const streamAsync = async () => {
    try {
      const session = await getSession(sessionId);
      if (!session) throw new Error("Session not found");

      // Auto-name session on first user message (fire-and-forget)
      const userMessages = session.messages.filter((m) => m.role === "user");
      if (session.title === "New chat" && userMessages.length === 1) {
        generateSessionName(sessionId, userMessages[0].content, providerName, model)
          .then((updated) => {
            if (updated) {
              broadcastToAllClients("__sessions__", { type: "session_updated", data: updated });
            }
          })
          .catch(console.error);
      }

      const history = buildHistoryFromDB(session.messages);

      const provider = getProvider(providerName);
      const stream = getStream(sessionId);
      const aiStream = provider.generateStream(
        history,
        model,
        tools,
        stream?.abortController.signal,
        sessionId,
      );
      let hasToolCalls = false;

      for await (const chunk of aiStream) {
        if (chunk.type === "text" && chunk.text) {
          const event: SSEEvent = { type: "token", data: chunk.text };
          if (sessionId && assistantId) {
            pushEvent(sessionId, event);
          } else {
            ctx.push("", event);
          }
        } else if (chunk.type === "tool_call" && chunk.toolCall) {
          hasToolCalls = true;
          const event: SSEEvent = { type: "tool_call", data: chunk.toolCall };
          if (sessionId && assistantId) {
            pushEvent(sessionId, event);
          } else {
            ctx.push("", event);
          }
        } else if (chunk.type === "debug" && chunk.debug) {
          const event: SSEEvent = { type: "debug", data: chunk.debug };
          if (sessionId && assistantId) {
            pushEvent(sessionId, event);
          } else {
            ctx.push("", event);
          }
        } else if (chunk.type === "usage" && chunk.usage) {
          const event: SSEEvent = { type: "usage", data: chunk.usage };
          if (sessionId && assistantId) {
            pushEvent(sessionId, event);
          } else {
            ctx.push("", event);
          }
          if (sessionId) {
            updateSessionTokenUsage(sessionId, chunk.usage).catch(console.error);
          }
        }
      }

      // Save assistant message to DB before pushing done
      if (sessionId && assistantId) {
        const stream = getStream(sessionId);
        if (stream) {
          const msg = {
            id: assistantId,
            role: "assistant" as const,
            content: stream.content,
            model,
            timestamp: Date.now(),
            toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
            approvalStatus: hasToolCalls ? ("pending" as const) : undefined,
            llmRequest: stream.requestBody,
            llmResponse: {
              content: stream.content,
              toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
              usage: stream.usage,
            },
            tokenCount: estimateMessageTokens({
              id: assistantId,
              role: "assistant",
              content: stream.content,
              timestamp: 0,
              toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
            }),
            rawTokenCount: stream.usage?.outputTokens,
          };
          await addMessage(sessionId, msg);

          if (stream.usage?.inputTokens) {
            const session = await getSession(sessionId);
            if (session) {
              for (let i = session.messages.length - 1; i >= 0; i--) {
                if (session.messages[i].role === "user") {
                  await updateMessage(session.messages[i].id, {
                    rawTokenCount: stream.usage.inputTokens,
                  });
                  break;
                }
              }
            }
          }
        }
      }

      // Auto-approve: if enabled for this session, approve and execute tools without client round-trip
      if (hasToolCalls && sessionId && assistantId) {
        const autoApprove = await getSessionAutoApprove(sessionId);
        if (autoApprove) {
          const approved = await atomicApprove(assistantId);
          if (approved) {
            pushEvent(sessionId, { type: "auto_approved", data: { messageId: assistantId } });
            executeToolRound(
              sessionId,
              assistantId,
              model,
              providerName,
              tools,
              0,
            ).catch((err) => {
              console.error("Auto-approve tool execution failed:", err);
            });
            return; // Don't push done — tool loop continues the stream
          }
        }
      }

      const doneEvent: SSEEvent = { type: "done", data: { hasToolCalls } };
      if (sessionId && assistantId) {
        pushEvent(sessionId, doneEvent);

        // Auto-compact if context usage exceeds threshold
        if (!hasToolCalls) {
          const stream = getStream(sessionId);
          if (stream?.usage) {
            const compactionMsg = await autoCompactIfNeeded(
              sessionId, model, providerName, stream.usage,
            );
            if (compactionMsg) {
              pushEvent(sessionId, { type: "compaction", data: compactionMsg });
            }
          }
        }

        scheduleRemoval(sessionId);
      } else {
        ctx.push("", doneEvent);
      }
    } catch (err) {
      // Check if this was an intentional abort
      const stream = sessionId ? getStream(sessionId) : null;
      const wasAborted = stream?.aborted || (err instanceof Error && err.name === "AbortError");

      if (wasAborted) {
        // Stream was aborted by user - send done event
        // The interrupted message was already appended and pushed by messages.interrupt handler
        const doneEvent: SSEEvent = { type: "done", data: { hasToolCalls: false } };
        if (sessionId && assistantId) {
          // Save the assistant message with interrupted content before sending done
          if (stream) {
            const msg = {
              id: assistantId,
              role: "assistant" as const,
              content: stream.content,
              model,
              timestamp: Date.now(),
              toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
              approvalStatus: stream.toolCalls.length > 0 ? ("pending" as const) : undefined,
              llmRequest: stream.requestBody,
              llmResponse: {
                content: stream.content,
                toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
                usage: stream.usage,
              },
              tokenCount: estimateMessageTokens({
                id: assistantId,
                role: "assistant",
                content: stream.content,
                timestamp: 0,
                toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
              }),
              rawTokenCount: stream.usage?.outputTokens,
            };
            await addMessage(sessionId, msg);
          }
          pushEvent(sessionId, doneEvent);
          scheduleRemoval(sessionId);
        } else {
          ctx.push("", doneEvent);
        }
      } else {
        // Actual error - classify and send structured error
        const classified = classifyLLMError(err instanceof Error ? err : new Error("Unknown error"));
        const event: SSEEvent = { type: "error", data: classified };
        if (sessionId && assistantId) {
          pushEvent(sessionId, event);
          scheduleRemoval(sessionId);
        } else {
          ctx.push("", event);
        }
      }
    }
  };

  // Fire and forget — the push events carry the streaming data
  streamAsync().catch(console.error);

  // Return ACK immediately
  return {};
});

// ---------------------------------------------------------------------------
// Streaming: chat.subscribe (reconnection)
// ---------------------------------------------------------------------------

registerHandler("chat.subscribe", async (payload, ctx) => {
  const schema = z.object({ sessionId: z.string().min(1) });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsError(400, JSON.stringify(parsed.error.flatten()));

  const { sessionId } = parsed.data;
  const stream = getStream(sessionId);
  if (!stream) {
    return { active: false };
  }

  // Send snapshot
  const snapshotEvent: SSEEvent = {
    type: "snapshot",
    data: {
      assistantId: stream.assistantId,
      content: stream.content,
      model: stream.model,
      toolCalls: stream.toolCalls,
    },
  };
  ctx.push(sessionId, snapshotEvent);

  // If stream is already done, send terminal events
  if (stream.done) {
    if (stream.error) {
      ctx.push(sessionId, { type: "error", data: stream.error });
    } else {
      ctx.push(sessionId, { type: "done", data: { hasToolCalls: stream.hasToolCalls } });
    }
    if (stream.usage) {
      ctx.push(sessionId, { type: "usage", data: stream.usage });
    }
    return { active: true };
  }

  // Subscribe for live updates
  const subscriber = (event: SSEEvent) => {
    ctx.push(sessionId, event);
  };
  stream.subscribers.add(subscriber);
  ctx.addSubscription(sessionId, subscriber);

  return { active: true };
});
