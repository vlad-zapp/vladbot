import { describe, it, expect } from "vitest";
import {
  generateTypingDelays,
  generateShortcutDelays,
} from "../services/tools/vnc/humanize/typing.js";

describe("generateTypingDelays", () => {
  it("returns array matching text length", () => {
    const text = "Hello, world!";
    const delays = generateTypingDelays(text);
    expect(delays).toHaveLength(text.length);
  });

  it("all delays are at least 20ms", () => {
    const delays = generateTypingDelays("test string with some words");
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(20);
    }
  });

  it("returns empty array for empty text", () => {
    const delays = generateTypingDelays("");
    expect(delays).toHaveLength(0);
  });

  it("all delays are numbers", () => {
    const delays = generateTypingDelays("abc123!@#");
    for (const d of delays) {
      expect(typeof d).toBe("number");
      expect(Number.isFinite(d)).toBe(true);
    }
  });

  it("respects custom options", () => {
    const delays = generateTypingDelays("test", {
      baseDelay: 20,
      variation: 0,
      pauseChance: 0,
    });
    // With 0 variation and 0 pause chance, delays should all be close to 20
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(20);
      expect(d).toBeLessThan(100);
    }
  });
});

describe("generateShortcutDelays", () => {
  it("returns object with betweenKeys and holdRelease", () => {
    const result = generateShortcutDelays();
    expect(result).toHaveProperty("betweenKeys");
    expect(result).toHaveProperty("holdRelease");
  });

  it("values are positive numbers", () => {
    const result = generateShortcutDelays();
    expect(result.betweenKeys).toBeGreaterThan(0);
    expect(result.holdRelease).toBeGreaterThan(0);
  });

  it("betweenKeys is in reasonable range", () => {
    // 30 + random * 50 → [30, 80]
    for (let i = 0; i < 20; i++) {
      const { betweenKeys } = generateShortcutDelays();
      expect(betweenKeys).toBeGreaterThanOrEqual(30);
      expect(betweenKeys).toBeLessThanOrEqual(80);
    }
  });

  it("holdRelease is in reasonable range", () => {
    // 40 + random * 60 → [40, 100]
    for (let i = 0; i < 20; i++) {
      const { holdRelease } = generateShortcutDelays();
      expect(holdRelease).toBeGreaterThanOrEqual(40);
      expect(holdRelease).toBeLessThanOrEqual(100);
    }
  });
});
