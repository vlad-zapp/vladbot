import type { MessagePart } from "@vladbot/shared";
import { getProvider } from "../../ai/ProviderFactory.js";

export interface SubLLMOptions {
  /** Provider name (deepseek, gemini, anthropic) */
  provider: string;
  /** Model ID */
  model: string;
  /** System prompt (optional) */
  systemPrompt?: string;
}

export interface SubLLMResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Call an LLM with fresh context (no history).
 * Used by BrowserService for describe/find operations.
 */
export async function callSubLLM(
  userPrompt: string,
  options: SubLLMOptions,
): Promise<SubLLMResult> {
  const provider = getProvider(options.provider);

  const messages: MessagePart[] = [];

  // Add system prompt if provided
  if (options.systemPrompt) {
    messages.push({
      role: "user",
      content: options.systemPrompt,
    });
    messages.push({
      role: "assistant",
      content: "Understood. I will follow these instructions.",
    });
  }

  // Add user prompt
  messages.push({
    role: "user",
    content: userPrompt,
  });

  const response = await provider.generateResponse(
    messages,
    options.model,
    undefined, // no tools
  );

  return {
    text: response.text,
    usage: response.usage,
  };
}

/**
 * Call an LLM with conversation history (for multi-turn describe).
 * Each call adds to the conversation.
 */
export async function callSubLLMWithHistory(
  messages: MessagePart[],
  userPrompt: string,
  options: SubLLMOptions,
): Promise<{ text: string; messages: MessagePart[]; usage?: { inputTokens: number; outputTokens: number } }> {
  const provider = getProvider(options.provider);

  // Add new user message
  const updatedMessages: MessagePart[] = [
    ...messages,
    { role: "user", content: userPrompt },
  ];

  const response = await provider.generateResponse(
    updatedMessages,
    options.model,
    undefined, // no tools
  );

  // Add assistant response to history
  updatedMessages.push({
    role: "assistant",
    content: response.text,
  });

  return {
    text: response.text,
    messages: updatedMessages,
    usage: response.usage,
  };
}
