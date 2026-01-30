import type { AIProviderInterface } from "./AIProvider.js";
import { AnthropicProvider } from "./AnthropicProvider.js";
import { GeminiProvider } from "./GeminiProvider.js";
import { DeepSeekProvider } from "./DeepSeekProvider.js";
import { env } from "../../config/env.js";

const cache = new Map<string, AIProviderInterface>();

export function getProvider(name: string): AIProviderInterface {
  const existing = cache.get(name);
  if (existing) return existing;

  let provider: AIProviderInterface;
  switch (name) {
    case "anthropic":
      if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");
      provider = new AnthropicProvider();
      break;
    case "gemini":
      if (!env.GOOGLE_GEMINI_API_KEY) throw new Error("GOOGLE_GEMINI_API_KEY is not configured");
      provider = new GeminiProvider();
      break;
    case "deepseek":
      if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not configured");
      provider = new DeepSeekProvider();
      break;
    default:
      throw new Error(`Unknown provider: ${name}`);
  }

  cache.set(name, provider);
  return provider;
}
