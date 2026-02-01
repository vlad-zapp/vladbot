import { GoogleGenAI } from "@google/genai";
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
import { randomUUID } from "node:crypto";

export class GeminiProvider implements AIProviderInterface {
  private client: GoogleGenAI;

  constructor() {
    this.client = new GoogleGenAI({ apiKey: env.GOOGLE_GEMINI_API_KEY });
  }

  private async convertMessages(
    messages: MessagePart[],
    sessionId?: string,
  ): Promise<{ role: "user" | "model"; parts: Record<string, unknown>[] }[]> {
    const result: {
      role: "user" | "model";
      parts: Record<string, unknown>[];
    }[] = [];

    // Only attach images to the last tool message (current turn).
    // Older tool results get text-only to avoid bloating context with stale images.
    let lastToolIdx = -1;
    for (let j = messages.length - 1; j >= 0; j--) {
      if (messages[j].role === "tool") { lastToolIdx = j; break; }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "user") {
        if (msg.images?.length) {
          const useVisionOverride = await hasVisionModelAsync(sessionId);
          if (useVisionOverride) {
            // Vision model override: store image for vision_analyze tool
            const resolved = await resolveImageToBase64(msg.images[0]);
            if (resolved) {
              storeLatestImage(resolved.base64, resolved.mimeType);
            }
            result.push({
              role: "user",
              parts: [{ text: msg.content + "\n\n[The user attached an image. Use the vision_analyze tool to see and analyze it.]" }],
            });
          } else {
            // Native vision: send images inline
            const userParts: Record<string, unknown>[] = [];
            for (const img of msg.images) {
              const resolved = await resolveImageToBase64(img);
              if (resolved) {
                userParts.push({
                  inlineData: { mimeType: resolved.mimeType, data: resolved.base64 },
                });
              }
            }
            userParts.push({ text: msg.content });
            result.push({ role: "user", parts: userParts });
          }
        } else {
          result.push({ role: "user", parts: [{ text: msg.content }] });
        }
      } else if (msg.role === "assistant") {
        const parts: Record<string, unknown>[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: { name: tc.name, args: tc.arguments },
            });
          }
        }
        result.push({ role: "model", parts });
      } else if (msg.role === "tool") {
        // Gemini expects function responses as user role parts
        const parts: Record<string, unknown>[] = [];
        const includeImages = i === lastToolIdx;
        const useVisionOverride = await hasVisionModelAsync(sessionId);
        if (msg.toolResults) {
          for (const tr of msg.toolResults) {
            const toolName = findToolName(messages, tr.toolCallId);
            const extracted = await extractToolResultImage(tr.output);

            if (includeImages && extracted.imageBase64) {
              // Always store for the vision tool
              storeLatestImage(extracted.imageBase64, extracted.mimeType ?? "image/jpeg", extracted.rawBuffer);
            }

            if (includeImages && extracted.imageBase64 && useVisionOverride) {
              // Vision model override: let LLM use vision_analyze tool
              parts.push({
                functionResponse: {
                  name: toolName,
                  response: {
                    output: `${extracted.text}\n\n[This tool result includes an image. Use the vision_analyze tool to examine it — provide a specific prompt describing what you need to know.]`,
                  },
                },
              });
            } else {
              parts.push({
                functionResponse: {
                  name: toolName,
                  response: { output: extracted.text },
                },
              });
              if (includeImages && extracted.imageBase64) {
                // Native vision: send image inline
                parts.push({
                  inlineData: {
                    mimeType: extracted.mimeType,
                    data: extracted.imageBase64,
                  },
                });
              }
            }
          }
        }
        result.push({ role: "user", parts });
      }
    }

    return result;
  }

  private convertTools(
    tools: ToolDefinition[],
  ): { functionDeclarations: Record<string, unknown>[] }[] {
    return [
      {
        functionDeclarations: flattenToolsForLLM(tools).map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  async generateResponse(
    messages: MessagePart[],
    model: string,
    tools?: ToolDefinition[],
    sessionId?: string,
  ): Promise<{ text: string; toolCalls: ToolCall[]; usage?: { inputTokens: number; outputTokens: number } }> {
    const contents = await this.convertMessages(messages, sessionId);
    const config: Record<string, unknown> = {
      systemInstruction: await getSystemPrompt(),
    };
    if (tools?.length) {
      config.tools = this.convertTools(tools);
    }

    const response = await this.client.models.generateContent({
      model,
      contents,
      config,
    });

    let text = "";
    const toolCalls: ToolCall[] = [];

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.text) {
        text += part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.id ?? randomUUID(),
          name: part.functionCall.name ?? "",
          arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
        });
      }
    }

    const um = response.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    const usage = um
      ? { inputTokens: um.promptTokenCount ?? 0, outputTokens: um.candidatesTokenCount ?? 0 }
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
    const contents = await this.convertMessages(messages, sessionId);
    const config: Record<string, unknown> = {
      systemInstruction: await getSystemPrompt(),
    };
    if (tools?.length) {
      config.tools = this.convertTools(tools);
    }

    yield { type: "debug", debug: { direction: "request" as const, body: { model, contents, config } } };

    const requestOptions: Record<string, unknown> = {
      model,
      contents,
      config,
    };
    if (signal) {
      requestOptions.signal = signal;
    }

    const response = await this.client.models.generateContentStream(requestOptions);

    let lastUsage: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    for await (const chunk of response) {
      if (chunk.usageMetadata) {
        lastUsage = chunk.usageMetadata;
      }
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.text) {
          yield { type: "text", text: part.text };
        }
        if (part.functionCall) {
          // Gemini emits function calls complete (not streamed)
          yield {
            type: "tool_call",
            toolCall: {
              id: part.functionCall.id ?? randomUUID(),
              name: part.functionCall.name ?? "",
              arguments:
                (part.functionCall.args as Record<string, unknown>) ?? {},
            },
          };
        }
      }
    }

    if (lastUsage) {
      yield {
        type: "usage",
        usage: {
          inputTokens: lastUsage.promptTokenCount ?? 0,
          outputTokens: lastUsage.candidatesTokenCount ?? 0,
        },
      };
    }
  }
}

function findToolName(messages: MessagePart[], toolCallId: string): string {
  for (const msg of messages) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.id === toolCallId) return tc.name;
      }
    }
  }
  return "unknown";
}
