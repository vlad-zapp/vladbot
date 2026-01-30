import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const envSchema = z
  .object({
    ANTHROPIC_API_KEY: z.string().optional().default(""),
    GOOGLE_GEMINI_API_KEY: z.string().optional().default(""),
    DEEPSEEK_API_KEY: z.string().optional().default(""),
    PORT: z.coerce.number().default(3001),

    // PostgreSQL
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

    // Memory tool limits (in tokens)
    MEMORY_MAX_STORAGE_TOKENS: z.coerce.number().default(200000),
    MEMORY_MAX_RETURN_TOKENS: z.coerce.number().default(200000),

    // VNC coordinate detection
    VNC_COORDINATE_BACKEND: z.enum(["vision", "showui"]).optional().default("vision"),
    SHOWUI_API_URL: z.string().optional().default(""),

    // Vision model for providers that lack native vision (e.g. DeepSeek).
    // Format: "provider:model_id" (e.g. "gemini:gemini-2.0-flash").
    // If not set, non-vision providers receive text-only tool results.
    VISION_MODEL: z.string().optional().default(""),

    // VNC idle connection timeout in seconds. Connections are closed after
    // this period of inactivity. Default: 300 (5 minutes). Set to 0 to disable.
    VNC_CONNECTION_TIMEOUT: z.coerce.number().default(300),
  })
  .refine(
    (data) => data.ANTHROPIC_API_KEY || data.GOOGLE_GEMINI_API_KEY || data.DEEPSEEK_API_KEY,
    { message: "At least one API key must be set (ANTHROPIC_API_KEY, GOOGLE_GEMINI_API_KEY, or DEEPSEEK_API_KEY)" },
  );

const parsed = envSchema.parse(process.env);
export const env = parsed as typeof parsed & {
  ANTHROPIC_API_KEY: string;
  GOOGLE_GEMINI_API_KEY: string;
  DEEPSEEK_API_KEY: string;
};
