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
      "Use this tool to examine images from previous tool results (e.g. screenshots). " +
      "You decide what to ask — provide a specific prompt describing what information you need from the image.",
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

  async execute(args: Record<string, unknown>): Promise<string> {
    const prompt = args.prompt as string;
    if (!prompt) {
      return JSON.stringify({ error: "prompt is required" });
    }

    const image = getLatestImage();
    if (!image) {
      return JSON.stringify({
        error: "No image available. A tool that produces an image (e.g. screenshot) must be called first.",
      });
    }

    const result = await queryVisionModel(prompt, image.base64, image.mimeType);
    return JSON.stringify({ result });
  },
};
