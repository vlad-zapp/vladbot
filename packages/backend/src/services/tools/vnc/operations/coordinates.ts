import sharp from "sharp";
import { env } from "../../../../config/env.js";
import { getRuntimeSetting } from "../../../../config/runtimeSettings.js";
import { getSessionVisionModel } from "../../../sessionStore.js";
import { resolveConnection } from "../VncConnection.js";
import { saveSessionFile } from "../../../sessionFiles.js";
import type { CoordinateResult } from "../types.js";

const COORDINATE_PROMPT = (description: string) =>
  `Look at this screenshot and find the exact pixel coordinates of: "${description}".

Return ONLY a JSON object in this exact format: {"x": <number>, "y": <number>}
Do not include any other text, explanation, or markdown formatting. Just the JSON object.`;

export async function getCoordinates(
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<string> {
  const description = args.description as string;
  if (!description)
    throw new Error("Missing required argument: description");

  const backend = await getRuntimeSetting("vnc_coordinate_backend") || "vision";

  let x: number;
  let y: number;
  let confidence: number | undefined;
  let imgBuffer: Buffer | undefined;
  let imgWidth: number;
  let imgHeight: number;

  if (backend === "showui") {
    ({ x, y, confidence, imgBuffer, imgWidth, imgHeight } =
      await findWithShowUI(args, description));
  } else {
    ({ x, y, imgBuffer, imgWidth, imgHeight } =
      await findWithVisionModel(args, description, sessionId));
  }

  const result: CoordinateResult = {
    type: "coordinates",
    x,
    y,
    confidence,
    description,
  };

  // Overlay a marker on the screenshot so the LLM can see where the element was found
  if (imgBuffer && imgWidth && imgHeight) {
    const markedBuffer = await overlayMarker(imgBuffer, imgWidth, imgHeight, x, y);
    if (sessionId) {
      const filename = saveSessionFile(sessionId, markedBuffer, "jpg");
      result.image_url = `/api/sessions/${sessionId}/files/${filename}`;
    } else {
      result.image_base64 = `data:image/jpeg;base64,${markedBuffer.toString("base64")}`;
    }
  }

  return JSON.stringify(result);
}

async function overlayMarker(
  imgBuffer: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
): Promise<Buffer> {
  const crossSize = 20;
  const strokeWidth = 3;

  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${x - crossSize}" y1="${y - crossSize}" x2="${x + crossSize}" y2="${y + crossSize}"
            stroke="red" stroke-width="${strokeWidth}" />
      <line x1="${x + crossSize}" y1="${y - crossSize}" x2="${x - crossSize}" y2="${y + crossSize}"
            stroke="red" stroke-width="${strokeWidth}" />
      <circle cx="${x}" cy="${y}" r="5" fill="red" />
    </svg>`,
  );

  return sharp(imgBuffer)
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 75 })
    .toBuffer();
}

function parseCoordinateResponse(text: string): { x: number; y: number } {
  const match = text.match(/\{\s*"x"\s*:\s*(\d+)\s*,\s*"y"\s*:\s*(\d+)\s*\}/);
  if (!match) {
    throw new Error(`Could not parse coordinates from response: ${text}`);
  }
  return { x: parseInt(match[1], 10), y: parseInt(match[2], 10) };
}

// --- ShowUI backend ---

async function findWithShowUI(
  args: Record<string, unknown>,
  description: string,
): Promise<{ x: number; y: number; confidence?: number; imgBuffer: Buffer; imgWidth: number; imgHeight: number }> {
  const apiUrl = env.SHOWUI_API_URL;
  if (!apiUrl) throw new Error("SHOWUI_API_URL not configured");

  const conn = resolveConnection(args);
  const imgBuffer = await conn.takeScreenshot();
  const metadata = await sharp(imgBuffer).metadata();
  const imgWidth = metadata.width!;
  const imgHeight = metadata.height!;
  const base64Image = imgBuffer.toString("base64");

  // Gradio v5+ two-step API: POST to submit, GET SSE for result
  const submitRes = await fetch(`${apiUrl}/gradio_api/call/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      data: [
        { url: `data:image/jpeg;base64,${base64Image}` },
        description,
      ],
    }),
  });

  if (!submitRes.ok) {
    throw new Error(
      `ShowUI API submit error: ${submitRes.status} ${submitRes.statusText}`,
    );
  }

  const { event_id } = (await submitRes.json()) as { event_id: string };

  // SSE endpoint — stream-parse and abort as soon as we get the "complete"
  // event. Gradio keeps SSE connections open after "complete", so using
  // `res.text()` would hang forever.
  const sseAbort = new AbortController();
  const sseTimeout = setTimeout(() => sseAbort.abort(), 120_000);
  let sseText: string;
  try {
    const resultRes = await fetch(
      `${apiUrl}/gradio_api/call/predict/${event_id}`,
      { signal: sseAbort.signal },
    );
    if (!resultRes.ok) {
      throw new Error(
        `ShowUI API result error: ${resultRes.status} ${resultRes.statusText}`,
      );
    }

    sseText = await readSSEUntilComplete(resultRes, sseAbort);
  } finally {
    clearTimeout(sseTimeout);
  }
  const data = parseGradioSSE(sseText);
  const [normX, normY] = parseShowUIResponse(data);

  return {
    x: Math.round(normX * imgWidth),
    y: Math.round(normY * imgHeight),
    imgBuffer,
    imgWidth,
    imgHeight,
  };
}

/**
 * Read a Gradio SSE response body until we see the "complete" or "error"
 * event, then abort the connection immediately so we don't hang on the
 * long-lived SSE stream.
 */
async function readSSEUntilComplete(
  res: Response,
  abort: AbortController,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body from ShowUI SSE endpoint");

  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Check if we have a terminal event (complete or error)
      if (
        buf.includes("event: complete") ||
        buf.includes("event:complete") ||
        buf.includes("event: error") ||
        buf.includes("event:error")
      ) {
        // Make sure we also have the data: line after the event
        const lastEventIdx = Math.max(
          buf.lastIndexOf("event: complete"),
          buf.lastIndexOf("event:complete"),
          buf.lastIndexOf("event: error"),
          buf.lastIndexOf("event:error"),
        );
        const afterEvent = buf.slice(lastEventIdx);
        if (afterEvent.includes("data:")) {
          // We have the complete event + its data, abort and return
          abort.abort();
          return buf;
        }
      }
    }
  } catch (err) {
    // AbortError is expected — we abort after getting the complete event
    if (err instanceof DOMException && err.name === "AbortError") {
      return buf;
    }
    throw err;
  }

  return buf;
}

/** Parse Gradio SSE response text, extracting the data from the "complete" event. */
function parseGradioSSE(sseText: string): unknown[] {
  // SSE format: "event: complete\ndata: [\"0.49, 0.26\"]\n"
  const lines = sseText.split("\n");
  let foundComplete = false;
  for (const line of lines) {
    if (line.startsWith("event:") && line.includes("complete")) {
      foundComplete = true;
    }
    if (line.startsWith("event:") && line.includes("error")) {
      // Try to get error data from next data: line
      const idx = lines.indexOf(line);
      const dataLine = lines[idx + 1];
      const errMsg = dataLine?.startsWith("data:") ? dataLine.slice(5).trim() : "unknown";
      throw new Error(`ShowUI prediction failed: ${errMsg}`);
    }
    if (foundComplete && line.startsWith("data:")) {
      const json = line.slice(5).trim();
      return JSON.parse(json) as unknown[];
    }
  }
  throw new Error(`No complete event in ShowUI SSE response: ${sseText}`);
}

function parseShowUIResponse(data: unknown[]): [number, number] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Empty ShowUI response");
  }

  const coords = data[0];

  if (typeof coords === "string") {
    const parts = coords.split(",").map((s) => Number(s.trim()));
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return [parts[0], parts[1]];
    }
  }

  if (Array.isArray(coords) && coords.length >= 2) {
    return [Number(coords[0]), Number(coords[1])];
  }

  throw new Error(`Failed to parse ShowUI response: ${JSON.stringify(data)}`);
}

// --- Vision model backend ---

async function findWithVisionModel(
  args: Record<string, unknown>,
  description: string,
  sessionId?: string,
): Promise<{ x: number; y: number; imgBuffer: Buffer; imgWidth: number; imgHeight: number }> {
  let visionRaw: string | undefined;
  if (sessionId) {
    visionRaw = await getSessionVisionModel(sessionId) || undefined;
  }
  if (!visionRaw) {
    visionRaw = await getRuntimeSetting("vision_model");
  }
  if (!visionRaw) {
    throw new Error(
      "Vision model not configured. Set a vision model in Settings to use coordinate detection.",
    );
  }
  const idx = visionRaw.indexOf(":");
  if (idx <= 0) {
    throw new Error(`Invalid vision model format: "${visionRaw}". Expected "provider:model_id".`);
  }
  const provider = visionRaw.slice(0, idx);
  const model = visionRaw.slice(idx + 1);

  const conn = resolveConnection(args);
  const imgBuffer = await conn.takeScreenshot();
  const metadata = await sharp(imgBuffer).metadata();
  const imgWidth = metadata.width!;
  const imgHeight = metadata.height!;
  const base64Image = imgBuffer.toString("base64");
  const prompt = COORDINATE_PROMPT(description);

  let responseText: string;

  switch (provider) {
    case "anthropic":
      responseText = await findWithAnthropic(base64Image, prompt, model);
      break;
    case "gemini":
      responseText = await findWithGemini(base64Image, prompt, model);
      break;
    case "deepseek":
      responseText = await findWithDeepSeek(base64Image, prompt, model);
      break;
    default:
      throw new Error(`Unsupported provider for vision: ${provider}`);
  }

  const coords = parseCoordinateResponse(responseText);
  return { ...coords, imgBuffer, imgWidth, imgHeight };
}

async function findWithAnthropic(
  base64Image: string,
  prompt: string,
  model: string,
): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model,
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: base64Image,
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Anthropic");
  }
  return textBlock.text;
}

async function findWithGemini(
  base64Image: string,
  prompt: string,
  model: string,
): Promise<string> {
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey: env.GOOGLE_GEMINI_API_KEY });

  const response = await client.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: base64Image,
            },
          },
          { text: prompt },
        ],
      },
    ],
  });

  return response.text ?? "";
}

async function findWithDeepSeek(
  base64Image: string,
  prompt: string,
  model: string,
): Promise<string> {
  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64Image}` },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `DeepSeek API error: ${response.status} ${response.statusText}`,
    );
  }

  const result = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  return result.choices[0]?.message?.content ?? "";
}
