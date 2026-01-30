import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    GOOGLE_GEMINI_API_KEY: "test-gemini-key",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    MEMORY_MAX_STORAGE_TOKENS: 200000,
    MEMORY_MAX_RETURN_TOKENS: 200000,
    PORT: 3001,
    VNC_COORDINATE_BACKEND: "vision",
    SHOWUI_API_URL: "",
  },
}));

// Mock provider classes — they must be constructable (class-like)
vi.mock("../services/ai/AnthropicProvider.js", () => ({
  AnthropicProvider: class {
    _type = "anthropic";
    generateResponse = vi.fn();
    generateStream = vi.fn();
  },
}));

vi.mock("../services/ai/GeminiProvider.js", () => ({
  GeminiProvider: class {
    _type = "gemini";
    generateResponse = vi.fn();
    generateStream = vi.fn();
  },
}));

vi.mock("../services/ai/DeepSeekProvider.js", () => ({
  DeepSeekProvider: class {
    _type = "deepseek";
    generateResponse = vi.fn();
    generateStream = vi.fn();
  },
}));

const { getProvider } = await import("../services/ai/ProviderFactory.js");

describe("ProviderFactory", () => {
  it("returns an Anthropic provider when key is set", () => {
    const provider = getProvider("anthropic") as unknown as { _type: string };
    expect(provider).toBeDefined();
    expect(provider._type).toBe("anthropic");
  });

  it("returns a Gemini provider when key is set", () => {
    const provider = getProvider("gemini") as unknown as { _type: string };
    expect(provider).toBeDefined();
    expect(provider._type).toBe("gemini");
  });

  it("returns a DeepSeek provider when key is set", () => {
    const provider = getProvider("deepseek") as unknown as { _type: string };
    expect(provider).toBeDefined();
    expect(provider._type).toBe("deepseek");
  });

  it("throws for unknown provider", () => {
    expect(() => getProvider("openai")).toThrow("Unknown provider");
  });

  it("caches provider instances", () => {
    const a = getProvider("anthropic");
    const b = getProvider("anthropic");
    expect(a).toBe(b);
  });
});
