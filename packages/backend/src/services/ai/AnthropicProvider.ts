import Anthropic from "@anthropic-ai/sdk";
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

export class AnthropicProvider implements AIProviderInterface {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  private async convertMessages(
    messages: MessagePart[],
  ): Promise<Anthropic.Messages.MessageParam[]> {
    const result: Anthropic.Messages.MessageParam[] = [];

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
          const useVisionOverride = await hasVisionModelAsync();
          if (useVisionOverride) {
            // Vision model override: store image for vision_analyze tool
            const resolved = await resolveImageToBase64(msg.images[0]);
            if (resolved) {
              storeLatestImage(resolved.base64, resolved.mimeType);
            }
            result.push({
              role: "user",
              content: msg.content + "\n\n[The user attached an image. Use the vision_analyze tool to see and analyze it.]",
            });
          } else {
            // Native vision: send images inline
            const contentBlocks: Anthropic.Messages.ContentBlockParam[] = [];
            for (const img of msg.images) {
              const resolved = await resolveImageToBase64(img);
              if (resolved) {
                contentBlocks.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: resolved.mimeType as "image/jpeg",
                    data: resolved.base64,
                  },
                });
              }
            }
            contentBlocks.push({ type: "text", text: msg.content });
            result.push({ role: "user", content: contentBlocks });
          }
        } else {
          result.push({ role: "user", content: msg.content });
        }
      } else if (msg.role === "assistant") {
        const content: Anthropic.Messages.ContentBlockParam[] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
        }
        result.push({ role: "assistant", content });
      } else if (msg.role === "tool") {
        // Anthropic expects tool results as user messages with tool_result blocks
        const content: Anthropic.Messages.ToolResultBlockParam[] = [];
        const includeImages = i === lastToolIdx;
        const useVisionOverride = await hasVisionModelAsync();
        if (msg.toolResults) {
          for (const tr of msg.toolResults) {
            const extracted = await extractToolResultImage(tr.output);
            if (includeImages && extracted.imageBase64 && useVisionOverride) {
              // Vision model override: store image, let LLM use vision_analyze tool
              storeLatestImage(extracted.imageBase64, extracted.mimeType ?? "image/jpeg", extracted.rawBuffer);
              content.push({
                type: "tool_result",
                tool_use_id: tr.toolCallId,
                content: `${extracted.text}\n\n[This tool result includes an image. Use the vision_analyze tool to examine it — provide a specific prompt describing what you need to know.]`,
                is_error: tr.isError,
              });
            } else if (includeImages && extracted.imageBase64) {
              // Native vision: send image directly
              storeLatestImage(extracted.imageBase64, extracted.mimeType ?? "image/jpeg", extracted.rawBuffer);
              content.push({
                type: "tool_result",
                tool_use_id: tr.toolCallId,
                content: [
                  { type: "text", text: extracted.text },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: extracted.mimeType as "image/jpeg",
                      data: extracted.imageBase64,
                    },
                  },
                ],
                is_error: tr.isError,
              });
            } else {
              content.push({
                type: "tool_result",
                tool_use_id: tr.toolCallId,
                content: extracted.text,
                is_error: tr.isError,
              });
            }
          }
        }
        result.push({ role: "user", content });
      }
    }

    return result;
  }

  private convertTools(
    tools: ToolDefinition[],
  ): Anthropic.Messages.Tool[] {
    return flattenToolsForLLM(tools).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as unknown as Anthropic.Messages.Tool["input_schema"],
    }));
  }

  async generateResponse(
    messages: MessagePart[],
    model: string,
    tools?: ToolDefinition[],
  ): Promise<{ text: string; toolCalls: ToolCall[]; usage?: { inputTokens: number; outputTokens: number } }> {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 4096,
      system: await getSystemPrompt(),
      messages: await this.convertMessages(messages),
    };
    if (tools?.length) {
      params.tools = this.convertTools(tools);
    }

    const response = await this.client.messages.create(params);

    let text = "";
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    const usage = response.usage
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      : undefined;

    return { text, toolCalls, usage };
  }

  async *generateStream(
    messages: MessagePart[],
    model: string,
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 4096,
      system: await getSystemPrompt(),
      messages: await this.convertMessages(messages),
    };
    if (tools?.length) {
      params.tools = this.convertTools(tools);
    }

    yield { type: "debug", debug: { direction: "request" as const, body: params } };

    const stream = this.client.messages.stream(params, signal ? { signal } : {});

    // Buffer tool_use blocks: we accumulate input_json_delta chunks
    // and emit a complete ToolCall on content_block_stop
    let currentToolBlock: {
      id: string;
      name: string;
      jsonBuf: string;
    } | null = null;

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          currentToolBlock = {
            id: event.content_block.id,
            name: event.content_block.name,
            jsonBuf: "",
          };
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        } else if (
          event.delta.type === "input_json_delta" &&
          currentToolBlock
        ) {
          currentToolBlock.jsonBuf += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        if (currentToolBlock) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(currentToolBlock.jsonBuf || "{}");
          } catch {
            // empty args on parse failure
          }
          yield {
            type: "tool_call",
            toolCall: {
              id: currentToolBlock.id,
              name: currentToolBlock.name,
              arguments: args,
            },
          };
          currentToolBlock = null;
        }
      }
    }

    try {
      const finalMessage = await stream.finalMessage();
      yield {
        type: "usage",
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        },
      };
    } catch {
      // usage not available
    }
  }
}
