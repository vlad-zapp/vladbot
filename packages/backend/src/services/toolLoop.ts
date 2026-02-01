import { v4 as uuid } from "uuid";
import type {
  ChatMessage,
  MessagePart,
  SSEEvent,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@vladbot/shared";
import {
  getSession,
  addMessage,
  updateMessage,
  updateSessionTokenUsage,
  atomicApprove,
  getSessionAutoApprove,
} from "./sessionStore.js";
import { executeToolCalls, validateToolCalls } from "./tools/index.js";
import { getProvider } from "./ai/ProviderFactory.js";
import { classifyLLMError } from "./ai/errorClassifier.js";
import { autoCompactIfNeeded } from "./autoCompact.js";
import { VERBATIM_TAIL_COUNT } from "@vladbot/shared";
import { estimateMessageTokens } from "./tokenCounter.js";
import {
  createStream,
  continueStream,
  pushEvent,
  scheduleRemoval,
  getStream,
} from "./streamRegistry.js";

const MAX_TOOL_ROUNDS = 10;

/** Convert a ChatMessage to a MessagePart (wire format for the LLM). */
function toMessagePart(m: ChatMessage): MessagePart {
  const part: MessagePart = { role: m.role, content: m.content };
  if (m.images?.length) part.images = m.images;
  if (m.toolCalls?.length) part.toolCalls = m.toolCalls;
  if (m.toolResults?.length) part.toolResults = m.toolResults;
  return part;
}

/**
 * Rebuild MessagePart[] history from the DB for a session.
 *
 * Finds the last compaction message and builds:
 *   1. Compaction summary as a user/assistant pair
 *   2. Verbatim tail — messages immediately before the compaction, count
 *      read from compaction.verbatimCount (falls back to VERBATIM_TAIL_COUNT
 *      for old compactions without it). Stops at previous compaction or start.
 *   3. All messages after the compaction
 *
 * The verbatim tail provides precise boundary context that was excluded from
 * the compaction summary, avoiding duplication.
 */
export function buildHistoryFromDB(messages: ChatMessage[]): MessagePart[] {
  if (messages.length === 0) return [];

  // Find the last compaction message
  let compactionIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "compaction") {
      compactionIdx = i;
      break;
    }
  }

  // No compaction: include all messages as-is
  if (compactionIdx === -1) {
    const result: MessagePart[] = [];
    const seenToolCallIds = new Set<string>();
    for (const m of messages) {
      if (m.role === "tool" && !m.toolResults?.length) continue;
      // Skip duplicate tool messages (same toolCallId already seen)
      if (m.role === "tool" && m.toolResults?.length) {
        const isDup = m.toolResults.every((tr) => seenToolCallIds.has(tr.toolCallId));
        if (isDup) continue;
        for (const tr of m.toolResults) seenToolCallIds.add(tr.toolCallId);
      }
      result.push(toMessagePart(m));
    }
    return result;
  }

  const compaction = messages[compactionIdx];
  const result: MessagePart[] = [];

  // 1. Compaction summary as user/assistant pair
  result.push({
    role: "user",
    content: `[Summary of conversation prior to the messages below]\n${compaction.content}`,
  });
  result.push({
    role: "assistant",
    content:
      "Understood. I have the context summary. The messages that follow continue from where the summary ends.",
  });

  // 2. Verbatim tail — use stored verbatimCount, fall back to constant
  const tailCount = compaction.verbatimCount ?? VERBATIM_TAIL_COUNT;
  let tailStart = Math.max(0, compactionIdx - tailCount);
  // Stop at any previous compaction
  for (let i = compactionIdx - 1; i >= tailStart; i--) {
    if (messages[i].role === "compaction") {
      tailStart = i + 1;
      break;
    }
  }
  // Don't split a tool-call sequence: if tailStart lands on a tool message,
  // walk back to include the preceding assistant message with tool_calls.
  while (tailStart > 0 && messages[tailStart].role === "tool") {
    tailStart--;
  }
  for (let i = tailStart; i < compactionIdx; i++) {
    const m = messages[i];
    if (m.role === "tool" && !m.toolResults?.length) continue;
    result.push(toMessagePart(m));
  }

  // 3. All messages after the compaction
  // Skip leading tool messages that lost their assistant parent
  let postStart = compactionIdx + 1;
  while (postStart < messages.length && messages[postStart].role === "tool") {
    postStart++;
  }
  for (let i = postStart; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool" && !m.toolResults?.length) continue;
    result.push(toMessagePart(m));
  }

  return result;
}

/**
 * Execute a tool round: validate + run tools, save results, then stream
 * the next LLM round. Repeats automatically for up to MAX_TOOL_ROUNDS
 * if the LLM returns more tool calls (and auto-approve is on).
 *
 * This runs in the background — the caller should not await it.
 */
export async function executeToolRound(
  sessionId: string,
  messageId: string,
  model: string,
  provider: string,
  tools?: ToolDefinition[],
  round: number = 0,
): Promise<void> {
  if (round >= MAX_TOOL_ROUNDS) return;

  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const message = session.messages.find((m) => m.id === messageId);
  if (!message) throw new Error("Message not found");
  if (!message.toolCalls?.length) return;

  const toolCalls = message.toolCalls;

  // Validate tool calls first
  const validationErrors = validateToolCalls(toolCalls);
  if (validationErrors.length > 0) {
    const allResults: ToolResult[] = toolCalls.map((tc) => {
      const err = validationErrors.find((e) => e.toolCallId === tc.id);
      if (err) return err;
      return {
        toolCallId: tc.id,
        output: "Cancelled: another tool failed validation",
        isError: true,
      };
    });

    await updateMessage(messageId, { toolResults: allResults });

    // Create tool message
    const toolMsg: ChatMessage = {
      id: uuid(),
      role: "tool",
      content: "",
      timestamp: Date.now(),
      toolResults: allResults,
      tokenCount: estimateMessageTokens({ id: "", role: "tool", content: "", timestamp: 0, toolResults: allResults }),
    };
    await addMessage(sessionId, toolMsg);

    // Push results via SSE
    for (const r of allResults) {
      pushEvent(sessionId, { type: "tool_result", data: r });
    }

    // Continue to next LLM round so it sees the errors
    await streamNextRound(sessionId, model, provider, tools);
    return;
  }

  // Execute tools sequentially, checking for interruption between each
  const allResults: ToolResult[] = [];
  let hadError = false;
  let wasInterrupted = false;

  for (let i = 0; i < toolCalls.length; i++) {
    // Check if user cancelled before starting next tool
    const stream = getStream(sessionId);
    if (stream?.aborted) {
      wasInterrupted = true;
      break;
    }

    if (hadError) {
      const cancelledResult: ToolResult = {
        toolCallId: toolCalls[i].id,
        output: "Cancelled: previous tool failed",
        isError: true,
      };
      allResults.push(cancelledResult);
      pushEvent(sessionId, { type: "tool_result", data: cancelledResult });
      continue;
    }

    try {
      // This is async - user can cancel while this runs
      const results = await executeToolCalls([toolCalls[i]], sessionId);
      const result = results[0];

      // Check again after tool finished - user may have cancelled during execution
      const streamAfter = getStream(sessionId);
      if (streamAfter?.aborted) {
        wasInterrupted = true;
        break;
      }

      allResults.push(result);
      pushEvent(sessionId, { type: "tool_result", data: result });

      if (result.isError) {
        hadError = true;
      }
    } catch (err) {
      const errorResult: ToolResult = {
        toolCallId: toolCalls[i].id,
        output: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
        isError: true,
      };
      allResults.push(errorResult);
      pushEvent(sessionId, { type: "tool_result", data: errorResult });
      hadError = true;
    }
  }

  if (wasInterrupted) {
    // Create "interrupted" results for all tool calls that didn't get results
    const completedIds = new Set(allResults.map((r) => r.toolCallId));
    for (const tc of toolCalls) {
      if (!completedIds.has(tc.id)) {
        allResults.push({
          toolCallId: tc.id,
          output: "Tool execution was interrupted by user.",
          isError: true,
        });
      }
    }

    // Save results on the assistant message (same as denyToolRound)
    await updateMessage(messageId, {
      approvalStatus: "denied",
      toolResults: allResults,
    });

    // Create tool message for history with proper results
    const toolMsg: ChatMessage = {
      id: uuid(),
      role: "tool",
      content: "",
      timestamp: Date.now(),
      toolResults: allResults,
      tokenCount: estimateMessageTokens({ id: "", role: "tool", content: "", timestamp: 0, toolResults: allResults }),
    };
    await addMessage(sessionId, toolMsg);

    // Done - don't call LLM
    pushEvent(sessionId, { type: "done", data: { hasToolCalls: false } });
    scheduleRemoval(sessionId);
    return;
  }

  // All tools finished - save results
  await updateMessage(messageId, {
    approvalStatus: "approved",
    toolResults: allResults,
  });

  const toolMsg: ChatMessage = {
    id: uuid(),
    role: "tool",
    content: "",
    timestamp: Date.now(),
    toolResults: allResults,
    tokenCount: estimateMessageTokens({ id: "", role: "tool", content: "", timestamp: 0, toolResults: allResults }),
  };
  await addMessage(sessionId, toolMsg);

  // Stream next LLM round
  await streamNextRound(sessionId, model, provider, tools);
}

/**
 * Stream a new LLM round using the full session history from DB.
 */
async function streamNextRound(
  sessionId: string,
  model: string,
  providerName: string,
  tools?: ToolDefinition[],
): Promise<void> {
  // Re-read session to get updated history
  const session = await getSession(sessionId);
  if (!session) return;

  const history = buildHistoryFromDB(session.messages);
  const newAssistantId = uuid();

  // Reuse existing stream or create a new one
  let stream = continueStream(sessionId, newAssistantId);
  if (!stream) {
    stream = createStream(sessionId, newAssistantId, model);
  }

  // If stream was already aborted (user cancelled during tool execution),
  // create interrupted assistant message immediately without calling LLM
  if (stream.aborted) {
    const interruptContent = "[Interrupted by user]";
    await addMessage(sessionId, {
      id: newAssistantId,
      role: "assistant",
      content: interruptContent,
      model,
      timestamp: Date.now(),
      tokenCount: estimateMessageTokens({ id: newAssistantId, role: "assistant", content: interruptContent, timestamp: 0 }),
    });
    pushEvent(sessionId, { type: "done", data: { hasToolCalls: false } });
    scheduleRemoval(sessionId);
    return;
  }

  // Send snapshot so any connected clients know a new round started
  const snapshotEvent: SSEEvent = {
    type: "snapshot",
    data: {
      assistantId: newAssistantId,
      content: "",
      model,
      toolCalls: [],
    },
  };
  for (const sub of stream.subscribers) {
    sub(snapshotEvent);
  }

  try {
    const provider = getProvider(providerName);
    const aiStream = provider.generateStream(
      history,
      model,
      tools as ToolDefinition[] | undefined,
      stream.abortController.signal,
      sessionId,
    );
    let hasToolCalls = false;

    for await (const chunk of aiStream) {
      if (chunk.type === "text" && chunk.text) {
        pushEvent(sessionId, { type: "token", data: chunk.text });
      } else if (chunk.type === "tool_call" && chunk.toolCall) {
        hasToolCalls = true;
        pushEvent(sessionId, { type: "tool_call", data: chunk.toolCall });
      } else if (chunk.type === "debug" && chunk.debug) {
        pushEvent(sessionId, { type: "debug", data: chunk.debug });
      } else if (chunk.type === "usage" && chunk.usage) {
        pushEvent(sessionId, { type: "usage", data: chunk.usage });
        updateSessionTokenUsage(sessionId, chunk.usage).catch(console.error);
      }
    }

    // Save the assistant message to DB BEFORE pushing done so that the
    // frontend's onDone reload finds the message already persisted.
    const currentStream = getStream(sessionId);
    if (currentStream) {
      const tc = currentStream.toolCalls.length > 0 ? currentStream.toolCalls : undefined;
      await addMessage(sessionId, {
        id: newAssistantId,
        role: "assistant",
        content: currentStream.content,
        model,
        timestamp: Date.now(),
        toolCalls: tc,
        approvalStatus: hasToolCalls ? "pending" : undefined,
        llmRequest: currentStream.requestBody,
        llmResponse: {
          content: currentStream.content,
          toolCalls: tc,
          usage: currentStream.usage,
        },
        tokenCount: estimateMessageTokens({ id: newAssistantId, role: "assistant", content: currentStream.content, timestamp: 0, toolCalls: tc }),
        rawTokenCount: currentStream.usage?.outputTokens,
      });

      // Update the last user message with inputTokens for billing tracking
      if (currentStream.usage?.inputTokens) {
        const freshSession = await getSession(sessionId);
        if (freshSession) {
          for (let i = freshSession.messages.length - 1; i >= 0; i--) {
            if (freshSession.messages[i].role === "user") {
              await updateMessage(freshSession.messages[i].id, {
                rawTokenCount: currentStream.usage.inputTokens,
              });
              break;
            }
          }
        }
      }
    }

    // Auto-approve: re-read from session each round so mid-stream toggles take effect
    const autoApprove = await getSessionAutoApprove(sessionId);
    if (hasToolCalls && autoApprove) {
      const approved = await atomicApprove(newAssistantId);
      if (approved) {
        pushEvent(sessionId, { type: "auto_approved", data: { messageId: newAssistantId } });
        await executeToolRound(
          sessionId,
          newAssistantId,
          model,
          providerName,
          tools,
          0,
        );
        return;
      }
    }

    pushEvent(sessionId, { type: "done", data: { hasToolCalls } });

    if (currentStream && !hasToolCalls) {
      // Auto-compact if context usage exceeds threshold
      if (currentStream.usage) {
        const compactionMsg = await autoCompactIfNeeded(
          sessionId, model, providerName, currentStream.usage,
        );
        if (compactionMsg) {
          pushEvent(sessionId, { type: "compaction", data: compactionMsg });
        }
      }
      scheduleRemoval(sessionId);
    }
  } catch (err) {
    // Check if this was an intentional abort
    const currentStream = getStream(sessionId);
    const wasAborted = currentStream?.aborted || (err instanceof Error && err.name === "AbortError");

    if (wasAborted) {
      // Stream was aborted by user - send done event
      // The interrupted message was already appended and pushed by messages.interrupt handler
      const doneEvent: SSEEvent = { type: "done", data: { hasToolCalls: false } };

      // Save the assistant message with interrupted content before sending done
      if (currentStream) {
        const tc = currentStream.toolCalls.length > 0 ? currentStream.toolCalls : undefined;
        await addMessage(sessionId, {
          id: newAssistantId,
          role: "assistant",
          content: currentStream.content,
          model,
          timestamp: Date.now(),
          toolCalls: tc,
          approvalStatus: tc ? "denied" : undefined,
          llmRequest: currentStream.requestBody,
          llmResponse: {
            content: currentStream.content,
            toolCalls: tc,
            usage: currentStream.usage,
          },
          tokenCount: estimateMessageTokens({ id: newAssistantId, role: "assistant", content: currentStream.content, timestamp: 0, toolCalls: tc }),
          rawTokenCount: currentStream.usage?.outputTokens,
        });
      }

      pushEvent(sessionId, doneEvent);
      scheduleRemoval(sessionId);
    } else {
      // Actual error - classify and send structured error
      const classified = classifyLLMError(err instanceof Error ? err : new Error("Unknown error"));
      pushEvent(sessionId, { type: "error", data: classified });
      scheduleRemoval(sessionId);
    }
  }
}

/**
 * Create denial results for tool calls and persist to DB.
 */
export async function denyToolRound(
  sessionId: string,
  messageId: string,
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const message = session.messages.find((m) => m.id === messageId);
  if (!message) throw new Error("Message not found");
  if (!message.toolCalls?.length) return;

  const results: ToolResult[] = message.toolCalls.map((tc) => ({
    toolCallId: tc.id,
    output: "Tool call denied by user",
    isError: true,
  }));

  await updateMessage(messageId, {
    approvalStatus: "denied",
    toolResults: results,
  });

  const toolMsg: ChatMessage = {
    id: uuid(),
    role: "tool",
    content: "",
    timestamp: Date.now(),
    toolResults: results,
    tokenCount: estimateMessageTokens({ id: "", role: "tool", content: "", timestamp: 0, toolResults: results }),
  };
  await addMessage(sessionId, toolMsg);
}
