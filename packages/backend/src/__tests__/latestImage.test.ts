import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock modules that chain to PostgreSQL
vi.mock("../services/db.js", () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock("../services/sessionStore.js", () => ({
  getSessionVisionModel: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/sessionFiles.js", () => ({
  getSessionFilePath: vi.fn(),
}));

vi.mock("../config/env.js", () => ({
  env: {
    VISION_MODEL: "",
  },
}));

vi.mock("../config/runtimeSettings.js", () => ({
  getRuntimeSetting: vi.fn().mockResolvedValue(null),
}));

import {
  storeLatestImage,
  getLatestImage,
  getLatestImageBuffer,
  clearLatestImage,
} from "../services/ai/toolResultImages.js";

// ===========================================================================
// Per-session latestImage isolation tests
//
// These tests verify that latestImage is properly scoped to sessions
// and that concurrent operations across sessions don't interfere.
// ===========================================================================

describe("latestImage — per-session storage", () => {
  beforeEach(() => {
    clearLatestImage("session-A");
    clearLatestImage("session-B");
    clearLatestImage("session-C");
  });

  it("stores and retrieves image for a session", () => {
    storeLatestImage("session-A", "base64data", "image/jpeg");

    const result = getLatestImage("session-A");
    expect(result).not.toBeNull();
    expect(result!.base64).toBe("base64data");
    expect(result!.mimeType).toBe("image/jpeg");
  });

  it("returns null for unknown session", () => {
    expect(getLatestImage("nonexistent")).toBeNull();
  });

  it("returns null for buffer of unknown session", () => {
    expect(getLatestImageBuffer("nonexistent")).toBeNull();
  });

  it("stores raw buffer alongside base64", () => {
    const buf = Buffer.from("raw-image-data");
    storeLatestImage("session-A", "base64data", "image/png", buf);

    const result = getLatestImageBuffer("session-A");
    expect(result).toBe(buf);
  });

  it("auto-creates buffer from base64 when not provided", () => {
    storeLatestImage("session-A", "aGVsbG8=", "image/jpeg");

    const buf = getLatestImageBuffer("session-A");
    expect(buf).not.toBeNull();
    expect(buf!.toString("base64")).toBe("aGVsbG8=");
  });

  it("overwrites previous image for the same session", () => {
    storeLatestImage("session-A", "first", "image/jpeg");
    storeLatestImage("session-A", "second", "image/png");

    const result = getLatestImage("session-A");
    expect(result!.base64).toBe("second");
    expect(result!.mimeType).toBe("image/png");
  });

  it("clearLatestImage removes only the specified session", () => {
    storeLatestImage("session-A", "img-A", "image/jpeg");
    storeLatestImage("session-B", "img-B", "image/jpeg");

    clearLatestImage("session-A");

    expect(getLatestImage("session-A")).toBeNull();
    expect(getLatestImage("session-B")!.base64).toBe("img-B");
  });

  it("clearLatestImage is safe to call on nonexistent session", () => {
    // Should not throw
    expect(() => clearLatestImage("nonexistent")).not.toThrow();
  });
});

describe("latestImage — cross-session isolation", () => {
  beforeEach(() => {
    clearLatestImage("session-A");
    clearLatestImage("session-B");
    clearLatestImage("session-C");
  });

  it("two sessions store different images without interference", () => {
    storeLatestImage("session-A", "img-A", "image/jpeg");
    storeLatestImage("session-B", "img-B", "image/png");

    expect(getLatestImage("session-A")!.base64).toBe("img-A");
    expect(getLatestImage("session-A")!.mimeType).toBe("image/jpeg");
    expect(getLatestImage("session-B")!.base64).toBe("img-B");
    expect(getLatestImage("session-B")!.mimeType).toBe("image/png");
  });

  it("interleaved store/read across sessions are isolated", () => {
    storeLatestImage("session-A", "A1", "image/jpeg");
    const readA1 = getLatestImage("session-A");

    storeLatestImage("session-B", "B1", "image/jpeg");
    const readB1 = getLatestImage("session-B");

    storeLatestImage("session-A", "A2", "image/jpeg");
    const readA2 = getLatestImage("session-A");

    // Each session has its correct latest value
    expect(readA1!.base64).toBe("A1");
    expect(readB1!.base64).toBe("B1");
    expect(readA2!.base64).toBe("A2");

    // B should still have B1 (unchanged by A2)
    expect(getLatestImage("session-B")!.base64).toBe("B1");
  });

  it("buffers are isolated across sessions", () => {
    const bufA = Buffer.from("data-A");
    const bufB = Buffer.from("data-B");

    storeLatestImage("session-A", "b64-A", "image/jpeg", bufA);
    storeLatestImage("session-B", "b64-B", "image/jpeg", bufB);

    expect(getLatestImageBuffer("session-A")).toBe(bufA);
    expect(getLatestImageBuffer("session-B")).toBe(bufB);
  });

  it("clearing one session does not affect others", () => {
    storeLatestImage("session-A", "A", "image/jpeg");
    storeLatestImage("session-B", "B", "image/jpeg");
    storeLatestImage("session-C", "C", "image/jpeg");

    clearLatestImage("session-B");

    expect(getLatestImage("session-A")!.base64).toBe("A");
    expect(getLatestImage("session-B")).toBeNull();
    expect(getLatestImage("session-C")!.base64).toBe("C");
  });

  it("many concurrent sessions operate independently", () => {
    const sessions = Array.from({ length: 20 }, (_, i) => `session-${i}`);

    // Store unique images for each session
    for (const sid of sessions) {
      storeLatestImage(sid, `img-${sid}`, "image/jpeg");
    }

    // Verify each session has its own image
    for (const sid of sessions) {
      const img = getLatestImage(sid);
      expect(img!.base64).toBe(`img-${sid}`);
    }

    // Clean up
    for (const sid of sessions) {
      clearLatestImage(sid);
    }
  });
});
