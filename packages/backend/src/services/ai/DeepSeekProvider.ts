import type { MessagePart, ToolDefinition, ToolCall } from "@vladbot/shared";
import type { AIProviderInterface, StreamChunk } from "./AIProvider.js";
import { flattenToolsForLLM } from "../tools/buildToolDef.js";
import {
  extractToolResultImage,
  resolveImageToBase64,
  hasVisionModelAsync,
  storeLatestImage,
} from "./toolResultImages.js";
import { env } from "../../config/env.js";
import { getSystemPrompt } from "./systemPrompt.js";

const API_URL = "https://api.deepseek.com/v1/chat/completions";

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class DeepSeekProvider implements AIProviderInterface {
  private headers: Record<string, string>;

  constructor() {
    this.headers = {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    };
  }

  private async convertMessages(messages: MessagePart[], sessionId?: string): Promise<OpenAIMessage[]> {
    const result: OpenAIMessage[] = [];
    const visionAvailable = await hasVisionModelAsync(sessionId);
    const systemPrompt = await getSystemPrompt();

    if (!visionAvailable) {
      result.push({
        role: "system",
        content:
          systemPrompt + "\n\n" +
          "You are a text-only model with no vision capabilities. " +
          "You cannot see or analyze images, screenshots, or any visual content. " +
          "If the user asks you to look at, describe, or interact with visual content " +
          "(such as screenshots, images on screen, UI elements, or anything requiring sight), " +
          "you MUST clearly explain that you cannot process images because no vision model " +
          "is configured. Suggest the user configure a VISION_MODEL (e.g. gemini:gemini-2.0-flash) " +
          "in the server settings, or switch to a vision-capable model like Gemini or Claude.",
      });
    } else {
      result.push({
        role: "system",
        content: systemPrompt,
      });
    }

    // Only handle images for the last tool message (current turn)
    let lastToolIdx = -1;
    for (let j = messages.length - 1; j >= 0; j--) {
      if (messages[j].role === "tool") { lastToolIdx = j; break; }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "user") {
        let content = msg.content;
        if (msg.images?.length) {
          // DeepSeek is text-only; store the first image for the vision tool
          const resolved = await resolveImageToBase64(msg.images[0]);
          if (resolved && sessionId) {
            storeLatestImage(sessionId, resolved.base64, resolved.mimeType);
          }
          if (visionAvailable) {
            content += "\n\n[The user attached an image. Use the vision_analyze tool to see and analyze it.]";
          }
        }
        result.push({ role: "user", content });
      } else if (msg.role === "assistant") {
        const m: OpenAIMessage = {
          role: "assistant",
          content: msg.content || null,
        };
        if (msg.toolCalls?.length) {
          m.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        }
        result.push(m);
      } else if (msg.role === "tool") {
        if (msg.toolResults) {
          for (const tr of msg.toolResults) {
            const extracted = await extractToolResultImage(tr.output);
            let content = extracted.text;

            if (i === lastToolIdx && extracted.imageBase64) {
              // Store image for the vision tool to consume
              if (sessionId) storeLatestImage(sessionId, extracted.imageBase64, extracted.mimeType ?? "image/jpeg", extracted.rawBuffer);

              if (visionAvailable) {
                content = `${extracted.text}\n\n[This tool result includes an image. Use the vision_analyze tool to examine it — provide a specific prompt describing what you need to know.]`;
              }
            }

            result.push({
              role: "tool",
              content,
              tool_call_id: tr.toolCallId,
            });
          }
        }
      }
    }

    return result;
  }

  private convertTools(tools: ToolDefinition[]): OpenAITool[] {
    return flattenToolsForLLM(tools).map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async generateResponse(
    messages: MessagePart[],
    model: string,
    tools?: ToolDefinition[],
    sessionId?: string,
  ): Promise<{ text: string; toolCalls: ToolCall[]; usage?: { inputTokens: number; outputTokens: number } }> {
    const converted = await this.convertMessages(messages, sessionId);
    const body: Record<string, unknown> = {
      model,
      messages: converted,
      stream: false,
    };
    if (tools?.length) {
      body.tools = this.convertTools(tools);
    }

    const response = await fetch(API_URL, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as {
      choices: {
        message: {
          content?: string | null;
          tool_calls?: {
            id: string;
            function: { name: string; arguments: string };
          }[];
        };
      }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const msg = data.choices[0]?.message;
    const text = msg?.content ?? "";
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));

    const usage = data.usage
      ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
      : undefined;

    return { text, toolCalls, usage };
  }

  async *generateStream(
    messages: MessagePart[],
    model: string,
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    sessionId?: string,
  ): AsyncIterable<StreamChunk> {
    const converted = await this.convertMessages(messages, sessionId);
    const body: Record<string, unknown> = {
      model,
      messages: converted,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools?.length) {
      body.tools = this.convertTools(tools);
    }

    yield { type: "debug", debug: { direction: "request" as const, body } };

    const fetchOptions: RequestInit = {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    };
    if (signal) {
      fetchOptions.signal = signal;
    }

    const response = await fetch(API_URL, fetchOptions);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error (${response.status}): ${error}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Buffer for tool calls being streamed incrementally
    const toolCallBuffers = new Map<
      number,
      { id: string; name: string; argsBuf: string }
    >();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const json = trimmed.slice(6);
        if (json === "[DONE]") {
          // Emit any remaining buffered tool calls
          for (const buf of toolCallBuffers.values()) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(buf.argsBuf || "{}");
            } catch {
              // empty args on parse failure
            }
            yield {
              type: "tool_call",
              toolCall: { id: buf.id, name: buf.name, arguments: args },
            };
          }
          return;
        }

        try {
          const event = JSON.parse(json) as {
            choices: {
              delta: {
                content?: string | null;
                tool_calls?: {
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }[];
              };
              finish_reason?: string | null;
            }[];
            usage?: {
              prompt_tokens: number;
              completion_tokens: number;
            };
          };

          // Usage-only chunk (sent after all content when stream_options.include_usage is true)
          if (event.usage) {
            yield {
              type: "usage",
              usage: {
                inputTokens: event.usage.prompt_tokens,
                outputTokens: event.usage.completion_tokens,
              },
            };
          }

          const delta = event.choices?.[0]?.delta;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            yield { type: "text", text: delta.content };
          }

          // Tool call deltas
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallBuffers.has(idx)) {
                toolCallBuffers.set(idx, {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  argsBuf: "",
                });
              }
              const buf = toolCallBuffers.get(idx)!;
              if (tc.id) buf.id = tc.id;
              if (tc.function?.name) buf.name = tc.function.name;
              if (tc.function?.arguments) {
                buf.argsBuf += tc.function.arguments;
              }
            }
          }

          // On finish_reason "tool_calls", emit buffered tool calls
          if (event.choices[0]?.finish_reason === "tool_calls") {
            for (const buf of toolCallBuffers.values()) {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(buf.argsBuf || "{}");
              } catch {
                // empty args on parse failure
              }
              yield {
                type: "tool_call",
                toolCall: { id: buf.id, name: buf.name, arguments: args },
              };
            }
            toolCallBuffers.clear();
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  }
}
