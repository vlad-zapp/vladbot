import { encoding_for_model } from "tiktoken";
import type { ChatMessage } from "@vladbot/shared";

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
