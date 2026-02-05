import { Router } from "express";
import type { SSEEvent } from "@vladbot/shared";
import { AVAILABLE_MODELS, findModel, formatModelField } from "@vladbot/shared";
import { getProvider } from "../services/ai/ProviderFactory.js";
import { executeToolCalls, validateToolCalls, getToolDefinitions } from "../services/tools/index.js";
import { addMessage, getSession, getSessionModel, updateSession, updateSessionTokenUsage, updateMessage } from "../services/sessionStore.js";
import {
  createStream,
  pushEvent,
  scheduleRemoval,
} from "../services/streamRegistry.js";
import { chatRequestSchema, toolExecuteSchema } from "./schemas.js";
import { getLLMContext } from "../services/context/index.js";
import { estimateMessageTokens } from "../services/tokenCounter.js";
import { classifyLLMError } from "../services/ai/errorClassifier.js";
import { getSetting } from "../services/settingsStore.js";

const router = Router();

router.post("/chat/stream", async (req, res) => {
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { sessionId, assistantId } = parsed.data;

  // Resolve model/provider from session (server is source of truth)
  const storedModel = await getSessionModel(sessionId);
  if (storedModel === null) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  let modelInfo = storedModel ? findModel(storedModel) : undefined;
  if (!modelInfo) {
    const defaultModelSetting = await getSetting("default_model");
    modelInfo =
      (defaultModelSetting && findModel(defaultModelSetting)) ||
      AVAILABLE_MODELS[0];
    await updateSession(sessionId, { model: formatModelField(modelInfo) });
  }
  const model = modelInfo.id;
  const providerName = modelInfo.provider;
  const tools = getToolDefinitions();

  // Register stream in the registry so it survives client disconnects
  if (assistantId) {
    createStream(sessionId, assistantId, model);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Subscribe this SSE response to the registry
  let unsubscribed = false;
  const send = (event: SSEEvent) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  if (assistantId) {
    const { getStream } = await import("../services/streamRegistry.js");
    const stream = getStream(sessionId);
    if (stream) {
      stream.subscribers.add(send);
      res.on("close", () => {
        stream.subscribers.delete(send);
        unsubscribed = true;
      });
    }
  }

  try {
    const history = await getLLMContext(sessionId);
    if (history.length === 0) throw new Error("Session not found or empty");

    const provider = getProvider(providerName);
    const aiStream = provider.generateStream(
      history,
      model,
      tools,
      undefined,
      sessionId,
    );
    let hasToolCalls = false;

    for await (const chunk of aiStream) {
      if (chunk.type === "text" && chunk.text) {
        const event: SSEEvent = { type: "token", data: chunk.text };
        if (sessionId && assistantId) {
          pushEvent(sessionId, event);
        } else {
          send(event);
        }
      } else if (chunk.type === "tool_call" && chunk.toolCall) {
        hasToolCalls = true;
        const event: SSEEvent = { type: "tool_call", data: chunk.toolCall };
        if (sessionId && assistantId) {
          pushEvent(sessionId, event);
        } else {
          send(event);
        }
      } else if (chunk.type === "debug" && chunk.debug) {
        const event: SSEEvent = { type: "debug", data: chunk.debug };
        if (sessionId && assistantId) {
          pushEvent(sessionId, event);
        } else {
          send(event);
        }
      } else if (chunk.type === "usage" && chunk.usage) {
        const event: SSEEvent = { type: "usage", data: chunk.usage };
        if (sessionId && assistantId) {
          pushEvent(sessionId, event);
        } else {
          send(event);
        }
        if (sessionId) {
          updateSessionTokenUsage(sessionId, chunk.usage).catch(console.error);
        }
      }
    }

    // Save assistant message to DB BEFORE pushing done so the frontend's
    // onDone reload finds the message already persisted.
    if (sessionId && assistantId) {
      const { getStream: getStr } = await import(
        "../services/streamRegistry.js"
      );
      const stream = getStr(sessionId);
      if (stream) {
        const msg = {
          id: assistantId,
          role: "assistant" as const,
          content: stream.content,
          model,
          timestamp: Date.now(),
          toolCalls:
            stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
          approvalStatus: hasToolCalls ? ("pending" as const) : undefined,
          llmRequest: stream.requestBody,
          llmResponse: {
            content: stream.content,
            toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
            usage: stream.usage,
          },
          tokenCount: estimateMessageTokens({ id: assistantId, role: "assistant", content: stream.content, timestamp: 0, toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined }),
          rawTokenCount: stream.usage?.outputTokens,
        };
        await addMessage(sessionId, msg);

        // Update the last user message with inputTokens for billing tracking
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

    const doneEvent: SSEEvent = { type: "done", data: { hasToolCalls } };
    if (sessionId && assistantId) {
      pushEvent(sessionId, doneEvent);
      // Keep the stream briefly for reconnection, then clean up
      scheduleRemoval(sessionId);
    } else {
      send(doneEvent);
    }
  } catch (err) {
    const classified = classifyLLMError(err instanceof Error ? err : new Error(String(err)));
    const event: SSEEvent = { type: "error", data: classified };
    if (sessionId && assistantId) {
      pushEvent(sessionId, event);
      scheduleRemoval(sessionId);
    } else {
      send(event);
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

router.post("/chat/tools/validate", (req, res) => {
  const parsed = toolExecuteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const errors = validateToolCalls(parsed.data.toolCalls);
  res.json({ errors });
});

router.post("/chat/tools/execute", async (req, res) => {
  const parsed = toolExecuteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const results = await executeToolCalls(
      parsed.data.toolCalls,
      parsed.data.sessionId,
    );
    res.json({ results });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Tool execution failed";
    res.status(500).json({ error: message });
  }
});

export default router;
