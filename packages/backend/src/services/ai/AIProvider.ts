import type { MessagePart, ToolDefinition, ToolCall } from "@vladbot/shared";

export interface StreamChunk {
  type: "text" | "tool_call" | "debug" | "usage";
  text?: string;
  toolCall?: ToolCall;
  debug?: { direction: "request"; body: unknown };
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AIProviderInterface {
  generateResponse(
    messages: MessagePart[],
    model: string,
    tools?: ToolDefinition[],
  ): Promise<{ text: string; toolCalls: ToolCall[]; usage?: { inputTokens: number; outputTokens: number } }>;

  generateStream(
    messages: MessagePart[],
    model: string,
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk>;
}
