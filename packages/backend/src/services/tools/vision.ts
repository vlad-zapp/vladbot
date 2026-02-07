import type { Tool } from "./ToolExecutor.js";
import {
  getLatestImage,
  queryVisionModel,
} from "../ai/toolResultImages.js";

export const visionTool: Tool = {
  definition: {
    name: "vision",
    description:
      "Analyze an image using a vision-capable model. " +
      "ONLY use when the user explicitly asks to analyze an image or see visual details. " +
      "Do NOT use for browser automation - use browser_describe instead which is faster and more reliable. " +
      "Requires a previous tool result with an image (e.g. screenshot).",
    operations: {
      analyze: {
        params: {
          prompt: {
            type: "string",
            description:
              "Your question or instruction for the vision model. " +
              "Be specific about what you need: read text, identify UI elements, check colors, etc.",
          },
        },
        required: ["prompt"],
      },
    },
  },

  async execute(args: Record<string, unknown>, sessionId?: string): Promise<string> {
    const prompt = args.prompt as string;
    if (!prompt) {
      return JSON.stringify({ error: "prompt is required" });
    }

    if (!sessionId) {
      return JSON.stringify({ error: "Session ID required for vision tool" });
    }

    const image = getLatestImage(sessionId);
    if (!image) {
      return JSON.stringify({
        error: "No image available. A tool that produces an image (e.g. screenshot) must be called first.",
      });
    }

    const result = await queryVisionModel(prompt, image.base64, image.mimeType, sessionId);
    return JSON.stringify({ result });
  },
};
