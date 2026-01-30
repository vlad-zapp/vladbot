import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetCachedSettings = vi.fn();

vi.mock("../services/settingsStore.js", () => ({
  getCachedSettings: () => mockGetCachedSettings(),
}));

vi.mock("../config/env.js", () => ({
  env: {
    VISION_MODEL: "gemini:gemini-2.0-flash",
    VNC_COORDINATE_BACKEND: "vision",
    SHOWUI_API_URL: "http://localhost:7860",
    VNC_CONNECTION_TIMEOUT: 300,
    MEMORY_MAX_STORAGE_TOKENS: 200000,
    MEMORY_MAX_RETURN_TOKENS: 200000,
  },
}));

const { getRuntimeSetting, getAllRuntimeSettings } = await import(
  "../config/runtimeSettings.js"
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getRuntimeSetting", () => {
  it("returns DB value when key exists", async () => {
    mockGetCachedSettings.mockResolvedValueOnce({
      vision_model: "anthropic:claude-sonnet-4",
    });

    const result = await getRuntimeSetting("vision_model");
    expect(result).toBe("anthropic:claude-sonnet-4");
  });

  it("returns env default when key is missing from DB", async () => {
    mockGetCachedSettings.mockResolvedValueOnce({});

    const result = await getRuntimeSetting("vision_model");
    expect(result).toBe("gemini:gemini-2.0-flash");
  });

  it("returns empty string when DB explicitly stores empty string", async () => {
    mockGetCachedSettings.mockResolvedValueOnce({
      vision_model: "",
    });

    const result = await getRuntimeSetting("vision_model");
    expect(result).toBe("");
  });

  it("does not fall back to env when DB value is empty string", async () => {
    mockGetCachedSettings.mockResolvedValueOnce({
      vision_model: "",
    });

    const result = await getRuntimeSetting("vision_model");
    // Must NOT return the env default "gemini:gemini-2.0-flash"
    expect(result).not.toBe("gemini:gemini-2.0-flash");
    expect(result).toBe("");
  });
});

describe("getAllRuntimeSettings", () => {
  it("merges DB values with env defaults", async () => {
    mockGetCachedSettings.mockResolvedValueOnce({
      vision_model: "anthropic:claude-sonnet-4",
    });

    const settings = await getAllRuntimeSettings();
    expect(settings.vision_model).toBe("anthropic:claude-sonnet-4");
    // Keys not in DB should use env defaults
    expect(settings.vnc_coordinate_backend).toBe("vision");
  });

  it("respects empty string from DB instead of falling back to env", async () => {
    mockGetCachedSettings.mockResolvedValueOnce({
      vision_model: "",
    });

    const settings = await getAllRuntimeSettings();
    // Must return "" (user explicitly cleared), not the env default
    expect(settings.vision_model).toBe("");
  });

  it("uses env default when key is absent from DB", async () => {
    mockGetCachedSettings.mockResolvedValueOnce({});

    const settings = await getAllRuntimeSettings();
    expect(settings.vision_model).toBe("gemini:gemini-2.0-flash");
    expect(settings.vnc_coordinate_backend).toBe("vision");
  });

  it("returns all expected keys", async () => {
    mockGetCachedSettings.mockResolvedValueOnce({});

    const settings = await getAllRuntimeSettings();
    expect(settings).toHaveProperty("default_model");
    expect(settings).toHaveProperty("vision_model");
    expect(settings).toHaveProperty("vnc_coordinate_backend");
    expect(settings).toHaveProperty("showui_api_url");
    expect(settings).toHaveProperty("vnc_keepalive_timeout");
    expect(settings).toHaveProperty("memory_max_storage_tokens");
    expect(settings).toHaveProperty("memory_max_return_tokens");
    expect(settings).toHaveProperty("system_prompt");
    expect(settings).toHaveProperty("context_compaction_threshold");
  });
});
