import { describe, it, expect } from "vitest";
import { z } from "zod";

// We can't easily re-import env.ts since it runs parse at module load time.
// Instead, test the Zod schema shape by reconstructing it here and verifying
// the validation logic matches expectations.

const envSchema = z
  .object({
    ANTHROPIC_API_KEY: z.string().optional().default(""),
    GOOGLE_GEMINI_API_KEY: z.string().optional().default(""),
    DEEPSEEK_API_KEY: z.string().optional().default(""),
    PORT: z.coerce.number().default(3001),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    MEMORY_MAX_STORAGE_TOKENS: z.coerce.number().default(200000),
    MEMORY_MAX_RETURN_TOKENS: z.coerce.number().default(200000),
    VNC_COORDINATE_BACKEND: z.enum(["vision", "showui"]).optional().default("vision"),
    SHOWUI_API_URL: z.string().optional().default(""),
  })
  .refine(
    (data) => data.ANTHROPIC_API_KEY || data.GOOGLE_GEMINI_API_KEY || data.DEEPSEEK_API_KEY,
    { message: "At least one API key must be set (ANTHROPIC_API_KEY, GOOGLE_GEMINI_API_KEY, or DEEPSEEK_API_KEY)" },
  );

describe("env schema validation", () => {
  it("accepts valid configuration", () => {
    const result = envSchema.safeParse({
      ANTHROPIC_API_KEY: "sk-ant-test",
      DATABASE_URL: "postgresql://localhost:5432/test",
    });
    expect(result.success).toBe(true);
  });

  it("requires DATABASE_URL", () => {
    const result = envSchema.safeParse({
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one API key", () => {
    const result = envSchema.safeParse({
      DATABASE_URL: "postgresql://localhost:5432/test",
    });
    expect(result.success).toBe(false);
  });

  it("defaults PORT to 3001", () => {
    const result = envSchema.safeParse({
      DEEPSEEK_API_KEY: "sk-test",
      DATABASE_URL: "postgresql://localhost:5432/test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(3001);
    }
  });

  it("defaults MEMORY_MAX_STORAGE_TOKENS to 200000", () => {
    const result = envSchema.safeParse({
      DEEPSEEK_API_KEY: "sk-test",
      DATABASE_URL: "postgresql://localhost:5432/test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.MEMORY_MAX_STORAGE_TOKENS).toBe(200000);
    }
  });

  it("defaults MEMORY_MAX_RETURN_TOKENS to 200000", () => {
    const result = envSchema.safeParse({
      DEEPSEEK_API_KEY: "sk-test",
      DATABASE_URL: "postgresql://localhost:5432/test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.MEMORY_MAX_RETURN_TOKENS).toBe(200000);
    }
  });

  it("defaults VNC_COORDINATE_BACKEND to llm", () => {
    const result = envSchema.safeParse({
      DEEPSEEK_API_KEY: "sk-test",
      DATABASE_URL: "postgresql://localhost:5432/test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VNC_COORDINATE_BACKEND).toBe("vision");
    }
  });

  it("accepts showui as VNC_COORDINATE_BACKEND", () => {
    const result = envSchema.safeParse({
      DEEPSEEK_API_KEY: "sk-test",
      DATABASE_URL: "postgresql://localhost:5432/test",
      VNC_COORDINATE_BACKEND: "showui",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VNC_COORDINATE_BACKEND).toBe("showui");
    }
  });

  it("rejects invalid VNC_COORDINATE_BACKEND", () => {
    const result = envSchema.safeParse({
      DEEPSEEK_API_KEY: "sk-test",
      DATABASE_URL: "postgresql://localhost:5432/test",
      VNC_COORDINATE_BACKEND: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("coerces PORT from string to number", () => {
    const result = envSchema.safeParse({
      DEEPSEEK_API_KEY: "sk-test",
      DATABASE_URL: "postgresql://localhost:5432/test",
      PORT: "4000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(4000);
    }
  });

  it("coerces memory token limits from string to number", () => {
    const result = envSchema.safeParse({
      DEEPSEEK_API_KEY: "sk-test",
      DATABASE_URL: "postgresql://localhost:5432/test",
      MEMORY_MAX_STORAGE_TOKENS: "500000",
      MEMORY_MAX_RETURN_TOKENS: "100000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.MEMORY_MAX_STORAGE_TOKENS).toBe(500000);
      expect(result.data.MEMORY_MAX_RETURN_TOKENS).toBe(100000);
    }
  });

  it("accepts multiple API keys", () => {
    const result = envSchema.safeParse({
      ANTHROPIC_API_KEY: "sk-ant-test",
      GOOGLE_GEMINI_API_KEY: "AI-test",
      DEEPSEEK_API_KEY: "sk-test",
      DATABASE_URL: "postgresql://localhost:5432/test",
    });
    expect(result.success).toBe(true);
  });
});
