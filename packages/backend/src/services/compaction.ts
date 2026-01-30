import { v4 as uuid } from "uuid";
import type { ChatMessage } from "@vladbot/shared";
import { VERBATIM_TAIL_COUNT } from "@vladbot/shared";
import { getSession, addMessage } from "./sessionStore.js";
import { getProvider } from "./ai/ProviderFactory.js";
import { estimateMessageTokens } from "./tokenCounter.js";
import { getRuntimeSetting } from "../config/runtimeSettings.js";

const SUMMARIZATION_PROMPT =
  "Summarize the following conversation concisely. Preserve all key facts, " +
  "decisions, tool usage results, and context needed to continue the conversation. " +
  "Do not add commentary — just the summary.";

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
 * Calculate verbatim tail count by walking backward from the end of
 * the message list, accumulating tokens until the budget is exhausted.
 *
 * @param budgetPercent - Percentage of context window for verbatim tail (0-50).
 *   If 0, returns 0 (no verbatim messages).
 *   Falls back to VERBATIM_TAIL_COUNT if contextWindow is 0 or not provided.
 */
export function calculateVerbatimCount(
  messages: ChatMessage[],
  contextWindow: number,
  budgetPercent: number = 40,
): number {
  if (!contextWindow || contextWindow <= 0) {
    return Math.min(VERBATIM_TAIL_COUNT, messages.length - 2);
  }

  // Clamp to 0-50%
  const pct = Math.max(0, Math.min(50, budgetPercent));
  if (pct === 0) return 0;

  const budgetTokens = Math.floor(contextWindow * (pct / 100));
  let count = 0;
  let tokensSoFar = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    // Always keep at least 2 messages for summarization
    if (messages.length - count <= 2) break;

    const msgTokens = estimateMessageTokens(messages[i]);
    if (tokensSoFar + msgTokens > budgetTokens) break;

    tokensSoFar += msgTokens;
    count++;
  }

  // Ensure at least 2 messages in the tail when possible
  return Math.max(count, Math.min(2, messages.length - 2));
}

/**
 * Compact a session's messages by summarizing older messages with an LLM.
 *
 * Uses a configurable token budget (compaction_verbatim_budget setting, default 40%)
 * of the context window to determine how many recent messages to keep verbatim.
 * The count is stored as `verbatimCount` on the compaction message so
 * buildHistoryFromDB knows exactly how many messages to include verbatim.
 *
 * Old messages are NOT deleted — they stay in the DB and UI.
 * The compaction message timestamp is Date.now() so it appears at the end.
 */
export async function compactSession(
  sessionId: string,
  model: string,
  providerName: string,
  contextWindow: number,
): Promise<{ compactionMessage: ChatMessage; summary: string }> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");

  const messages = session.messages;
  if (messages.length < 4) {
    throw new Error("Not enough messages to compact");
  }

  // Read configurable verbatim budget percentage
  const budgetStr = await getRuntimeSetting("compaction_verbatim_budget");
  const parsed = parseInt(budgetStr, 10);
  const budgetPercent = Number.isNaN(parsed) ? 40 : parsed;

  // Calculate verbatim tail count based on token budget
  const tailCount = calculateVerbatimCount(messages, contextWindow, budgetPercent);
  const summarizeSet = messages.slice(0, messages.length - tailCount);

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

  const compactionMsg: ChatMessage = {
    id: uuid(),
    role: "compaction",
    content: summary,
    timestamp: Date.now(),
    verbatimCount: tailCount,
    tokenCount: estimateMessageTokens({ id: "", role: "compaction", content: summary, timestamp: 0 }),
    rawTokenCount: usage?.outputTokens,
  };

  await addMessage(sessionId, compactionMsg);

  return { compactionMessage: compactionMsg, summary };
}
