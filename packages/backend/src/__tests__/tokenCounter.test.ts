import { describe, it, expect } from "vitest";
import { countTokens } from "../services/tokenCounter.js";

describe("countTokens", () => {
  it("returns a positive number for non-empty text", () => {
    const count = countTokens("Hello, world!");
    expect(count).toBeGreaterThan(0);
  });

  it("returns 0 for empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  it("scales with text length", () => {
    const short = countTokens("hi");
    const long = countTokens("This is a much longer piece of text that should have more tokens.");
    expect(long).toBeGreaterThan(short);
  });

  it("produces consistent results across calls", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    const count1 = countTokens(text);
    const count2 = countTokens(text);
    expect(count1).toBe(count2);
  });

  it("handles unicode text", () => {
    const count = countTokens("日本語テスト 🎉");
    expect(count).toBeGreaterThan(0);
  });
});
