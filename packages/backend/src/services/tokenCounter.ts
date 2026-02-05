import { encoding_for_model } from "tiktoken";
import type { ChatMessage, ToolResult } from "@vladbot/shared";

const encoder = encoding_for_model("gpt-4");

export function countTokens(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Estimate token count of a message's text content (excluding images).
 * Counts content + serialized tool calls + serialized tool results.
 */
export function estimateMessageTokens(msg: ChatMessage): number {
  let text = msg.content;
  if (msg.toolCalls) {
    text += JSON.stringify(msg.toolCalls);
  }
  if (msg.toolResults) {
    text += JSON.stringify(msg.toolResults);
  }
  return countTokens(text);
}

/**
 * Collapse a browser_content tool result to a short note.
 * Returns collapsed output string, or original if not browser_content.
 */
function collapseBrowserContent(output: string): string {
  try {
    const parsed = JSON.parse(output);
    if (parsed?.type === "browser_content") {
      return JSON.stringify({
        type: "browser_content",
        url: parsed.url,
        title: parsed.title,
        note: "[Content omitted]",
      });
    }
  } catch {
    // Not JSON or not browser_content
  }
  return output;
}

/**
 * Find the latest browser_get_content tool call ID in a list of messages.
 */
export function findLatestBrowserContentId(messages: ChatMessage[]): string | undefined {
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
          // ignore
        }
      }
    }
  }
  return undefined;
}

/**
 * Estimate token count with browser_content collapsing applied.
 * Old browser_content results (not matching latestBrowserContentId) are collapsed.
 */
export function estimateMessageTokensWithCollapsing(
  msg: ChatMessage,
  latestBrowserContentId?: string,
): number {
  let text = msg.content;
  if (msg.toolCalls) {
    text += JSON.stringify(msg.toolCalls);
  }
  if (msg.toolResults) {
    // Collapse old browser_content results
    const collapsedResults: ToolResult[] = msg.toolResults.map((tr) => {
      if (tr.toolCallId === latestBrowserContentId) return tr;
      return { ...tr, output: collapseBrowserContent(tr.output) };
    });
    text += JSON.stringify(collapsedResults);
  }
  return countTokens(text);
}
