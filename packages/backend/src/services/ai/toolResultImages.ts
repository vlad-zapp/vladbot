import { readFileSync } from "node:fs";
import sharp from "sharp";
import { getSessionFilePath } from "../sessionFiles.js";
import { getSessionVisionModel } from "../sessionStore.js";
import { env } from "../../config/env.js";
import { getRuntimeSetting } from "../../config/runtimeSettings.js";

export interface ExtractedToolResult {
  text: string;
  imageBase64?: string;
  mimeType?: string;
  rawBuffer?: Buffer;
}

/**
 * Compress an image buffer to JPEG at 75% quality to reduce token usage.
 */
async function compressToJpeg(buf: Buffer): Promise<Buffer> {
  return sharp(buf).jpeg({ quality: 75 }).toBuffer();
}

/**
 * Parse a tool result output string and extract any embedded image data.
 * Returns the text content (with image fields removed) and optionally
 * the raw base64 image data compressed as JPEG at 75% quality.
 *
 * Handles two formats:
 * - image_base64: "data:image/jpeg;base64,..." → strips prefix, compresses → base64
 * - image_url: "/api/sessions/:id/files/:name" → reads file from disk → compresses → base64
 */
export async function extractToolResultImage(output: string): Promise<ExtractedToolResult> {
  try {
    const parsed = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { text: output };
    }

    let rawBuffer: Buffer | undefined;

    if (typeof parsed.image_base64 === "string") {
      const match = parsed.image_base64.match(
        /^data:(image\/[^;]+);base64,(.+)$/,
      );
      if (match) {
        rawBuffer = Buffer.from(match[2], "base64");
      }
    } else if (typeof parsed.image_url === "string") {
      const urlMatch = parsed.image_url.match(
        /\/api\/sessions\/([^/]+)\/files\/([^/]+)$/,
      );
      if (urlMatch) {
        const filePath = getSessionFilePath(urlMatch[1], urlMatch[2]);
        if (filePath) {
          rawBuffer = readFileSync(filePath);
        }
      }
    }

    if (rawBuffer) {
      const compressed = await compressToJpeg(rawBuffer);
      const { image_base64: _b64, image_url: _url, ...rest } = parsed;
      return {
        text: JSON.stringify(rest),
        imageBase64: compressed.toString("base64"),
        mimeType: "image/jpeg",
        rawBuffer,
      };
    }
  } catch {
    // Not JSON — return as-is
  }

  return { text: output };
}

// ---------------------------------------------------------------------------
// Resolve standalone image strings (data URIs or session file URLs) to base64
// ---------------------------------------------------------------------------

export async function resolveImageToBase64(
  image: string,
): Promise<{ base64: string; mimeType: string } | null> {
  const dataMatch = image.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (dataMatch) {
    const compressed = await compressToJpeg(Buffer.from(dataMatch[2], "base64"));
    return { base64: compressed.toString("base64"), mimeType: "image/jpeg" };
  }

  const urlMatch = image.match(/\/api\/sessions\/([^/]+)\/files\/([^/]+)$/);
  if (urlMatch) {
    const filePath = getSessionFilePath(urlMatch[1], urlMatch[2]);
    if (filePath) {
      const compressed = await compressToJpeg(readFileSync(filePath));
      return { base64: compressed.toString("base64"), mimeType: "image/jpeg" };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// VISION_MODEL configuration
// ---------------------------------------------------------------------------

/**
 * Parse the vision model setting ("provider:model_id") into its parts.
 * If sessionId is provided, uses the session's visionModel exclusively —
 * sessions are seeded with the global setting at creation, so an empty value
 * means the user explicitly disabled vision for this session.
 * Falls back to global runtime settings only when no sessionId is given.
 */
async function parseVisionModel(sessionId?: string): Promise<{ provider: string; model: string } | null> {
  let raw: string | undefined;
  if (sessionId) {
    const sessionVision = await getSessionVisionModel(sessionId);
    if (sessionVision) raw = sessionVision;
    // No fallback to global — session value is authoritative
  } else {
    raw = await getRuntimeSetting("vision_model");
  }
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx <= 0) return null;
  return { provider: raw.slice(0, idx), model: raw.slice(idx + 1) };
}

/**
 * Synchronous check using env var only (for tool registration at startup).
 * Runtime checks should use parseVisionModel() instead.
 */
function parseVisionModelSync(): { provider: string; model: string } | null {
  const raw = env.VISION_MODEL;
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx <= 0) return null;
  return { provider: raw.slice(0, idx), model: raw.slice(idx + 1) };
}

/** Returns true if a dedicated vision model is configured (async, checks session then global). */
export async function hasVisionModelAsync(sessionId?: string): Promise<boolean> {
  return (await parseVisionModel(sessionId)) !== null;
}

/** Synchronous check for startup-time use (env var only). */
export function hasVisionModel(): boolean {
  return parseVisionModelSync() !== null;
}

// ---------------------------------------------------------------------------
// Latest-image buffer (for the vision tool to consume)
// ---------------------------------------------------------------------------

let latestImage: { base64: string; mimeType: string; rawBuffer: Buffer } | null = null;

export function storeLatestImage(base64: string, mimeType: string, rawBuffer?: Buffer): void {
  latestImage = {
    base64,
    mimeType,
    rawBuffer: rawBuffer ?? Buffer.from(base64, "base64"),
  };
}

export function getLatestImage(): { base64: string; mimeType: string } | null {
  return latestImage;
}

/** Get the raw image buffer (full quality) for tools like ShowUI coordinate detection. */
export function getLatestImageBuffer(): Buffer | null {
  return latestImage?.rawBuffer ?? null;
}

// ---------------------------------------------------------------------------
// Send prompt + image to the configured VISION_MODEL
// ---------------------------------------------------------------------------

/**
 * Send an image and a caller-provided prompt to the configured vision model.
 * The calling LLM decides what to ask — this function is prompt-agnostic.
 */
export async function queryVisionModel(
  prompt: string,
  imageBase64: string,
  mimeType: string = "image/jpeg",
  sessionId?: string,
): Promise<string> {
  const vm = await parseVisionModel(sessionId);
  if (!vm) {
    return "[Error: no VISION_MODEL configured]";
  }

  if (vm.provider === "gemini") {
    const apiKey = env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) return "[Error: GOOGLE_GEMINI_API_KEY not set for vision model]";

    const { GoogleGenAI } = await import("@google/genai");
    const client = new GoogleGenAI({ apiKey });

    const response = await client.models.generateContent({
      model: vm.model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            { text: prompt },
          ],
        },
      ],
    });
    return response.text ?? "[Vision model returned no response]";
  }

  if (vm.provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return "[Error: ANTHROPIC_API_KEY not set for vision model]";

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: vm.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mimeType as "image/jpeg", data: imageBase64 },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock && "text" in textBlock ? textBlock.text : "[Vision model returned no response]";
  }

  return `[Error: unsupported vision provider "${vm.provider}"]`;
}
