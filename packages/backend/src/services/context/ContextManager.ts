import { v4 as uuid } from "uuid";
import type { ChatMessage, MessagePart, ToolResult } from "@vladbot/shared";
import { AVAILABLE_MODELS } from "@vladbot/shared";
import { getSession, addMessage } from "../sessionStore.js";
import { getProvider } from "../ai/ProviderFactory.js";
import {
  estimateMessageTokens,
  estimateMessageTokensWithCollapsing,
  findLatestBrowserContentId,
  countTokens,
} from "../tokenCounter.js";
import { getRuntimeSetting } from "../../config/runtimeSettings.js";
import {
  createSnapshot,
  getActiveSnapshot,
  setActiveSnapshot,
  updateSessionTokenCount,
  getSessionTokenCount,
  getMessagesByIds,
  type ContextSnapshot,
  type CreateSnapshotParams,
} from "./SnapshotStore.js";

const SUMMARIZATION_PROMPT =
  "Summarize the following conversation concisely. Preserve all key facts, " +
  "decisions, tool usage results, and context needed to continue the conversation. " +
  "Do not add commentary — just the summary.";

/**
 * Result of a compaction operation.
 */
export interface CompactionResult {
  snapshot: ContextSnapshot;
  /** ChatMessage for UI display (backward compatible). */
  compactionMessage: ChatMessage;
  summary: string;
  newTokenUsage: { inputTokens: number; outputTokens: number };
}

/**
 * Find the ID of the latest browser_get_content tool call that has a result.
 */
function findLatestBrowserContentToolCallId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.toolResults) {
      for (const tr of m.toolResults) {
        try {
          const parsed = JSON.parse(tr.output);
          if (parsed?.type === "browser_content") {
            return tr.toolCallId;
          }
        } catch {
          // Not JSON
        }
      }
    }
  }
  return undefined;
}

/**
 * Convert a ChatMessage to a MessagePart (wire format for the LLM).
 * Optionally collapses old browser_get_content results to save context space.
 */
function toMessagePart(
  m: ChatMessage,
  latestBrowserContentId?: string,
): MessagePart {
  const part: MessagePart = { role: m.role, content: m.content };
  if (m.images?.length) part.images = m.images;
  if (m.toolCalls?.length) part.toolCalls = m.toolCalls;

  if (m.toolResults?.length) {
    part.toolResults = m.toolResults.map((tr) => {
      if (tr.toolCallId === latestBrowserContentId) return tr;

      try {
        const parsed = JSON.parse(tr.output);
        if (parsed?.type === "browser_content") {
          const collapsed = {
            type: "browser_content",
            url: parsed.url,
            title: parsed.title,
            note: "[Content omitted - see latest browser_get_content result for current page state]",
          };
          return { ...tr, output: JSON.stringify(collapsed) };
        }
      } catch {
        // Not JSON or not browser_content
      }

      return tr;
    });
  }

  return part;
}

/**
 * Format messages into a readable conversation for summarization.
 */
function formatForSummary(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "compaction") {
      parts.push(`[Previous summary]\n${msg.content}`);
    } else if (msg.role === "user") {
      parts.push(`User: ${msg.content}`);
    } else if (msg.role === "assistant") {
      let line = `Assistant: ${msg.content}`;
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          line += `\n[Tool call: ${tc.name}(${JSON.stringify(tc.arguments)})]`;
        }
      }
      if (msg.toolResults) {
        for (const tr of msg.toolResults) {
          const output =
            tr.output.length > 500 ? tr.output.slice(0, 500) + "..." : tr.output;
          line += `\n[Tool result: ${output}]`;
        }
      }
      parts.push(line);
    } else if (msg.role === "tool") {
      if (msg.toolResults) {
        for (const tr of msg.toolResults) {
          const output =
            tr.output.length > 500 ? tr.output.slice(0, 500) + "..." : tr.output;
          parts.push(`[Tool result: ${output}]`);
        }
      }
    }
  }
  return parts.join("\n\n");
}

/**
 * Get LLM-ready context for a session.
 *
 * If the session has an active snapshot, returns:
 *   [summary as user/assistant pair] + [verbatim messages] + [messages after snapshot]
 *
 * If no snapshot exists (no compaction yet), returns all messages.
 */
export async function getLLMContext(sessionId: string): Promise<MessagePart[]> {
  const session = await getSession(sessionId);
  if (!session) return [];

  const snapshot = await getActiveSnapshot(sessionId);

  if (!snapshot) {
    // No compaction yet - use legacy buildHistoryFromDB logic for old sessions
    // that may have compaction messages without snapshots
    return buildHistoryFromDB(session.messages);
  }

  // Find latest browser content for collapsing
  const allMessages = session.messages;
  const latestBrowserContentId = findLatestBrowserContentToolCallId(allMessages);

  const result: MessagePart[] = [];

  // 1. Summary as user/assistant pair
  result.push({
    role: "user",
    content: `[Summary of conversation prior to the messages below]\n${snapshot.summary}`,
  });
  result.push({
    role: "assistant",
    content: "Understood. I have the context summary. The messages that follow continue from where the summary ends.",
  });

  // 2. Verbatim messages from snapshot
  const verbatimMsgs = await getMessagesByIds(snapshot.verbatimMessageIds);
  for (const m of verbatimMsgs) {
    if (m.role === "tool" && !m.toolResults?.length) continue;
    result.push(toMessagePart(m, latestBrowserContentId));
  }

  // 3. Messages after the snapshot was created
  // Find the timestamp of the last verbatim message
  const lastVerbatimTimestamp = verbatimMsgs.length > 0
    ? verbatimMsgs[verbatimMsgs.length - 1].timestamp
    : 0;

  // Get messages that came after the verbatim messages
  for (const m of allMessages) {
    if (m.timestamp <= lastVerbatimTimestamp) continue;
    if (m.role === "compaction") continue; // Skip old compaction messages
    if (m.role === "tool" && !m.toolResults?.length) continue;
    result.push(toMessagePart(m, latestBrowserContentId));
  }

  return result;
}

/**
 * Legacy: Rebuild MessagePart[] history from the DB for sessions without snapshots.
 * This handles old compaction messages that use verbatimCount.
 */
export function buildHistoryFromDB(messages: ChatMessage[]): MessagePart[] {
  if (messages.length === 0) return [];

  const latestBrowserContentId = findLatestBrowserContentToolCallId(messages);

  // Find the last compaction message
  let compactionIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "compaction") {
      compactionIdx = i;
      break;
    }
  }

  // No compaction: include all messages
  if (compactionIdx === -1) {
    const result: MessagePart[] = [];
    const seenToolCallIds = new Set<string>();
    for (const m of messages) {
      if (m.role === "tool" && !m.toolResults?.length) continue;
      if (m.role === "tool" && m.toolResults?.length) {
        const isDup = m.toolResults.every((tr) => seenToolCallIds.has(tr.toolCallId));
        if (isDup) continue;
        for (const tr of m.toolResults) seenToolCallIds.add(tr.toolCallId);
      }
      result.push(toMessagePart(m, latestBrowserContentId));
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
    content: "Understood. I have the context summary. The messages that follow continue from where the summary ends.",
  });

  // 2. Verbatim tail
  const VERBATIM_TAIL_COUNT = 5; // Fallback for old compactions
  const tailCount = compaction.verbatimCount ?? VERBATIM_TAIL_COUNT;
  let tailStart = Math.max(0, compactionIdx - tailCount);

  // Stop at any previous compaction
  for (let i = compactionIdx - 1; i >= tailStart; i--) {
    if (messages[i].role === "compaction") {
      tailStart = i + 1;
      break;
    }
  }

  // Don't split a tool-call sequence
  while (tailStart > 0 && messages[tailStart].role === "tool") {
    tailStart--;
  }

  for (let i = tailStart; i < compactionIdx; i++) {
    const m = messages[i];
    if (m.role === "tool" && !m.toolResults?.length) continue;
    result.push(toMessagePart(m, latestBrowserContentId));
  }

  // 3. All messages after the compaction
  let postStart = compactionIdx + 1;
  while (postStart < messages.length && messages[postStart].role === "tool") {
    postStart++;
  }

  for (let i = postStart; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool" && !m.toolResults?.length) continue;
    result.push(toMessagePart(m, latestBrowserContentId));
  }

  return result;
}

/**
 * Calculate which messages to keep verbatim based on token budget.
 */
function calculateVerbatimMessages(
  messages: ChatMessage[],
  contextWindow: number,
  budgetPercent: number,
): { summarize: ChatMessage[]; verbatim: ChatMessage[] } {
  if (!contextWindow || contextWindow <= 0 || messages.length < 4) {
    // Fallback: keep last 5 or half, whichever is smaller
    const verbatimCount = Math.min(5, Math.floor(messages.length / 2));
    return {
      summarize: messages.slice(0, messages.length - verbatimCount),
      verbatim: messages.slice(messages.length - verbatimCount),
    };
  }

  const pct = Math.max(0, Math.min(50, budgetPercent));
  if (pct === 0) {
    return { summarize: messages, verbatim: [] };
  }

  const budgetTokens = Math.floor(contextWindow * (pct / 100));
  let count = 0;
  let tokensSoFar = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages.length - count <= 2) break; // Keep at least 2 for summary

    const msgTokens = estimateMessageTokens(messages[i]);
    if (tokensSoFar + msgTokens > budgetTokens) break;

    tokensSoFar += msgTokens;
    count++;
  }

  // Ensure at least 2 messages in verbatim when possible
  count = Math.max(count, Math.min(2, messages.length - 2));

  return {
    summarize: messages.slice(0, messages.length - count),
    verbatim: messages.slice(messages.length - count),
  };
}

/**
 * Perform compaction for a session - creates a new snapshot.
 *
 * @param sessionId - The session to compact
 * @param model - Model ID to use for summarization
 * @param providerName - Provider name for the model
 * @param contextWindow - Target context window size for verbatim budget calculation
 */
export async function performCompaction(
  sessionId: string,
  model: string,
  providerName: string,
  contextWindow: number,
): Promise<CompactionResult> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const messages = session.messages.filter((m) => m.role !== "compaction");
  if (messages.length < 4) {
    throw new Error("Not enough messages to compact");
  }

  // Read configurable verbatim budget percentage
  const budgetStr = await getRuntimeSetting("compaction_verbatim_budget");
  const parsed = parseInt(budgetStr, 10);
  const budgetPercent = Number.isNaN(parsed) ? 40 : parsed;

  // Calculate which messages to summarize vs keep verbatim
  const { summarize: summarizeSet, verbatim: verbatimSet } = calculateVerbatimMessages(
    messages,
    contextWindow,
    budgetPercent,
  );

  // Get current token count for trigger tracking
  const currentTokenCount = await getSessionTokenCount(sessionId);

  // Format and summarize with LLM
  const conversationText = formatForSummary(summarizeSet);
  const provider = getProvider(providerName);
  const { text: summary, usage } = await provider.generateResponse(
    [
      {
        role: "user",
        content: `${SUMMARIZATION_PROMPT}\n\n---\n\n${conversationText}`,
      },
    ],
    model,
  );

  // Calculate token counts
  const summaryTokenCount = countTokens(summary);
  const latestBrowserContentId = findLatestBrowserContentId(verbatimSet);
  let verbatimTokenCount = 0;
  for (const msg of verbatimSet) {
    verbatimTokenCount += estimateMessageTokensWithCollapsing(msg, latestBrowserContentId);
  }

  // Create the snapshot
  const snapshotParams: CreateSnapshotParams = {
    sessionId,
    summary,
    summaryTokenCount,
    verbatimMessageIds: verbatimSet.map((m) => m.id),
    verbatimTokenCount,
    triggerTokenCount: currentTokenCount || 0,
    modelUsed: model,
  };

  const snapshot = await createSnapshot(snapshotParams);

  // Update session to use this snapshot
  await setActiveSnapshot(sessionId, snapshot.id);

  // Reset running token count to snapshot total
  await updateSessionTokenCount(sessionId, snapshot.totalTokenCount);

  // Create a compaction message for backward compatibility (UI display)
  const verbatimNote = verbatimSet.length > 0
    ? `\n\n---\n_Last ${verbatimSet.length} message${verbatimSet.length === 1 ? "" : "s"} preserved verbatim for conversation continuity._`
    : "";

  const compactionMsg: ChatMessage = {
    id: uuid(),
    role: "compaction",
    content: summary + verbatimNote,
    timestamp: Date.now(),
    verbatimCount: verbatimSet.length,
    tokenCount: estimateMessageTokens({
      id: "",
      role: "compaction",
      content: summary + verbatimNote,
      timestamp: 0,
    }),
    rawTokenCount: usage?.outputTokens,
    displayType: "context_summary",
  };

  // Store the compaction message for UI display
  await addMessage(sessionId, compactionMsg);

  return {
    snapshot,
    compactionMessage: compactionMsg,
    summary,
    newTokenUsage: {
      inputTokens: snapshot.totalTokenCount,
      outputTokens: 0,
    },
  };
}

/**
 * Check if compaction is needed and perform it if so.
 * Returns the compaction result if performed, null otherwise.
 */
export async function autoCompactIfNeeded(
  sessionId: string,
  model: string,
  provider: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<CompactionResult | null> {
  const thresholdStr = await getRuntimeSetting("context_compaction_threshold");
  const threshold = parseInt(thresholdStr, 10) || 90;

  const modelInfo = AVAILABLE_MODELS.find((m) => m.id === model);
  if (!modelInfo || modelInfo.contextWindow <= 0) return null;

  const totalTokens = usage.inputTokens + usage.outputTokens;
  const pct = (totalTokens / modelInfo.contextWindow) * 100;
  if (pct < threshold) return null;

  try {
    return await performCompaction(sessionId, model, provider, modelInfo.contextWindow);
  } catch (err) {
    console.error("Auto-compaction failed:", err);
    return null;
  }
}

/**
 * Compute displayType for a message based on its role.
 */
export function computeDisplayType(message: ChatMessage): ChatMessage["displayType"] {
  switch (message.role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool_result";
    case "compaction":
      return "context_summary";
    default:
      return undefined;
  }
}

/**
 * Compute tool statuses for an assistant message with tool calls.
 */
export function computeToolStatuses(
  message: ChatMessage,
): Record<string, "pending" | "executing" | "done" | "cancelled" | "waiting"> | undefined {
  if (!message.toolCalls?.length) return undefined;

  const results = message.toolResults ?? [];
  const status = message.approvalStatus;
  const statuses: Record<string, "pending" | "executing" | "done" | "cancelled" | "waiting"> = {};

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
      // Approved - check if a previous tool errored
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

/**
 * Enrich a message with backend-computed display hints.
 */
export function enrichMessageForDisplay(message: ChatMessage): ChatMessage {
  return {
    ...message,
    displayType: computeDisplayType(message),
    toolStatuses: message.role === "assistant" ? computeToolStatuses(message) : undefined,
  };
}
