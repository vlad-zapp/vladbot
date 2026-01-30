import { Router } from "express";
import { z } from "zod";
import type { ChatMessage } from "@vladbot/shared";
import type { SSEEvent } from "@vladbot/shared";
import {
  createSession,
  listSessions,
  getSession,
  getMessages,
  updateSessionTitle,
  deleteSession,
  addMessage,
  updateMessage,
  atomicApprove,
} from "../services/sessionStore.js";
import { getSessionFilePath, saveSessionFile } from "../services/sessionFiles.js";
import { compactSession } from "../services/compaction.js";
import { createStream, getStream } from "../services/streamRegistry.js";
import { executeToolRound, denyToolRound } from "../services/toolLoop.js";
import { toolDefinitionSchema } from "./schemas.js";
import { estimateMessageTokens } from "../services/tokenCounter.js";
import { getSetting, putSettings } from "../services/settingsStore.js";

const router = Router();

router.get("/sessions", async (_req, res) => {
  const sessions = await listSessions();
  res.json(sessions);
});

// Last-active must be before /:id to avoid matching "last-active" as an id
router.get("/sessions/last-active", async (_req, res) => {
  const sessionId = await getSetting("last_active_session_id");
  res.json({ sessionId });
});

router.put("/sessions/last-active", async (req, res) => {
  const schema = z.object({ sessionId: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  await putSettings({ last_active_session_id: parsed.data.sessionId });
  res.json({ ok: true });
});

router.post("/sessions", async (req, res) => {
  const schema = z.object({ title: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const session = await createSession(parsed.data.title);
  res.status(201).json(session);
});

router.get("/sessions/:id", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(session);
});

router.patch("/sessions/:id", async (req, res) => {
  const schema = z.object({ title: z.string().min(1).max(200) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const session = await updateSessionTitle(req.params.id, parsed.data.title);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(session);
});

router.delete("/sessions/:id", async (req, res) => {
  const deleted = await deleteSession(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.status(204).end();
});

router.get("/sessions/:id/files/:filename", (req, res) => {
  const filePath = getSessionFilePath(req.params.id, req.params.filename);
  if (!filePath) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  res.sendFile(filePath);
});

router.post("/sessions/:id/messages", async (req, res) => {
  const msgSchema = z.object({
    id: z.string(),
    role: z.enum(["user", "assistant", "tool", "compaction"]),
    content: z.string(),
    images: z.array(z.string()).optional(),
    model: z.string().optional(),
    timestamp: z.number(),
    toolCalls: z.array(z.any()).optional(),
    toolResults: z.array(z.any()).optional(),
    approvalStatus: z.enum(["pending", "approved", "denied"]).optional(),
  });
  const parsed = msgSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const sessionId = req.params.id;
  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Convert data-URI images to session files
  const message = parsed.data as ChatMessage;
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
        // Already a URL
        urls.push(img);
      }
    }
    message.images = urls;
  }

  // Calculate token count (tiktoken estimate, excluding images)
  message.tokenCount = estimateMessageTokens(message);

  const dbId = await addMessage(sessionId, message);
  res.status(201).json({ ok: true, id: dbId, images: message.images, tokenCount: message.tokenCount });
});

// Paginated messages endpoint
router.get("/sessions/:id/messages", async (req, res) => {
  const before = req.query.before ? Number(req.query.before) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;

  if (before != null && isNaN(before)) {
    res.status(400).json({ error: "Invalid 'before' parameter" });
    return;
  }
  if (limit != null && (isNaN(limit) || limit < 1 || limit > 200)) {
    res.status(400).json({ error: "Invalid 'limit' parameter (1-200)" });
    return;
  }

  const result = await getMessages(req.params.id, { before, limit });
  // Return empty result rather than 404 for a session with no messages
  res.json({
    messages: result.messages,
    hasMore: result.hasMore,
  });
});

// SSE endpoint: subscribe to an active stream (for reconnection after refresh)
router.get("/sessions/:id/stream", (req, res) => {
  const stream = getStream(req.params.id);
  if (!stream) {
    res.status(204).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send a snapshot of accumulated state so the client can catch up
  const snapshotEvent: SSEEvent = {
    type: "snapshot",
    data: {
      assistantId: stream.assistantId,
      content: stream.content,
      model: stream.model,
      toolCalls: stream.toolCalls,
    },
  };
  res.write(`data: ${JSON.stringify(snapshotEvent)}\n\n`);

  // If stream is already done, send terminal events and close
  if (stream.done) {
    if (stream.error) {
      res.write(`data: ${JSON.stringify({ type: "error", data: stream.error })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ type: "done", data: { hasToolCalls: stream.hasToolCalls } })}\n\n`);
    }
    if (stream.usage) {
      res.write(`data: ${JSON.stringify({ type: "usage", data: stream.usage })}\n\n`);
    }
    res.end();
    return;
  }

  // Subscribe for live updates
  const send = (event: SSEEvent) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  stream.subscribers.add(send);

  res.on("close", () => {
    stream.subscribers.delete(send);
  });
});

router.post("/sessions/:id/compact", async (req, res) => {
  const schema = z.object({
    model: z.string().min(1),
    provider: z.string().min(1),
    contextWindow: z.number().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const result = await compactSession(
      req.params.id,
      parsed.data.model,
      parsed.data.provider,
      parsed.data.contextWindow,
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Compaction failed";
    res.status(500).json({ error: message });
  }
});

router.patch("/sessions/:id/messages/:messageId", async (req, res) => {
  const schema = z.object({
    toolResults: z.array(z.any()).optional(),
    approvalStatus: z.enum(["pending", "approved", "denied"]).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const session = await getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await updateMessage(req.params.messageId, parsed.data);
  res.json({ ok: true });
});

// --- Server-side tool approval & execution ---

const approveSchema = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
  tools: z.array(toolDefinitionSchema).optional(),
});

router.post("/sessions/:id/messages/:messageId/approve", async (req, res) => {
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const session = await getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const message = session.messages.find((m) => m.id === req.params.messageId);
  if (!message) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  if (message.approvalStatus !== "pending") {
    res.status(409).json({ error: `Message approval status is '${message.approvalStatus}', expected 'pending'` });
    return;
  }

  // Atomically set status to "approved" only if still "pending" (prevents TOCTOU race
  // where two concurrent approve requests both pass the check above).
  const updated = await atomicApprove(req.params.messageId);
  if (!updated) {
    res.status(409).json({ error: "Message was already approved by a concurrent request" });
    return;
  }

  // Always create a fresh stream — the old one from the first LLM round may
  // still exist with done=true, which would cause subscribers to resolve
  // immediately and miss the tool-execution round.
  createStream(req.params.id, req.params.messageId, parsed.data.model);

  // Return 202 — execution happens in background
  res.status(202).json({ ok: true });

  // Execute tools and continue conversation in background
  executeToolRound(
    req.params.id,
    req.params.messageId,
    parsed.data.model,
    parsed.data.provider,
    parsed.data.tools as import("@vladbot/shared").ToolDefinition[] | undefined,
  ).catch((err) => {
    console.error("Tool execution failed:", err);
  });
});

router.post("/sessions/:id/messages/:messageId/deny", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const message = session.messages.find((m) => m.id === req.params.messageId);
  if (!message) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  if (message.approvalStatus !== "pending") {
    res.status(409).json({ error: `Message approval status is '${message.approvalStatus}', expected 'pending'` });
    return;
  }

  try {
    await denyToolRound(req.params.id, req.params.messageId);
    res.json({ ok: true });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Deny failed";
    res.status(500).json({ error: errMsg });
  }
});

export default router;
