import type { ModelInfo } from "./types.js";

export const AVAILABLE_MODELS: ModelInfo[] = [
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic", contextWindow: 200_000, nativeVision: true },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", provider: "anthropic", contextWindow: 200_000, nativeVision: true },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "gemini", contextWindow: 1_048_576, nativeVision: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "gemini", contextWindow: 1_048_576, nativeVision: true },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "gemini", contextWindow: 1_048_576, nativeVision: true },
  { id: "deepseek-chat", name: "DeepSeek V3", provider: "deepseek", contextWindow: 65_536, nativeVision: false },
  { id: "deepseek-reasoner", name: "DeepSeek R1", provider: "deepseek", contextWindow: 65_536, nativeVision: false },
];

export const DEFAULT_MODEL = AVAILABLE_MODELS[0];

/**
 * Number of recent messages to keep verbatim (not summarized) during compaction.
 * These are included as proper messages in the LLM context after the compaction
 * summary, providing precise boundary context without duplication.
 */
export const VERBATIM_TAIL_COUNT = 5;

/** Current API version. Bump when the protocol changes. */
export const API_VERSION = 1;
