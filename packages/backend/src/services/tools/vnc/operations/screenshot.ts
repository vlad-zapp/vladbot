import sharp from "sharp";
import { resolveConnection } from "../VncConnection.js";
import type { ScreenshotResult } from "../types.js";
import { saveSessionFile } from "../../../sessionFiles.js";

function buildResult(
  imgBuffer: Buffer,
  width: number,
  height: number,
  sessionId?: string,
): string {
  const result: ScreenshotResult = {
    type: "screenshot",
    width,
    height,
  };

  if (sessionId) {
    const filename = saveSessionFile(sessionId, imgBuffer, "jpg");
    result.image_url = `/api/sessions/${sessionId}/files/${filename}`;
  } else {
    result.image_base64 = `data:image/jpeg;base64,${imgBuffer.toString("base64")}`;
  }

  return JSON.stringify(result);
}

export async function takeScreenshot(
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<string> {
  const conn = resolveConnection(args);
  const imgBuffer = await conn.takeScreenshot();
  return buildResult(imgBuffer, conn.width, conn.height, sessionId);
}

export async function markScreenshot(
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<string> {
  const coordinates = args.coordinates as Array<{ x: number; y: number }>;
  if (!coordinates || !Array.isArray(coordinates) || coordinates.length === 0) {
    throw new Error(
      "Missing required argument: coordinates (array of {x, y})",
    );
  }

  const conn = resolveConnection(args);
  const imgBuffer = await conn.takeScreenshot();
  const w = conn.width;
  const h = conn.height;

  const crossSize = 10;
  const strokeWidth = 2;

  const crossesSvg = coordinates
    .map((coord, i) => {
      const { x, y } = coord;
      return `
      <line x1="${x - crossSize}" y1="${y - crossSize}" x2="${x + crossSize}" y2="${y + crossSize}"
            stroke="red" stroke-width="${strokeWidth}" />
      <line x1="${x + crossSize}" y1="${y - crossSize}" x2="${x - crossSize}" y2="${y + crossSize}"
            stroke="red" stroke-width="${strokeWidth}" />
      <circle cx="${x}" cy="${y}" r="3" fill="red" />
      <text x="${x + crossSize + 4}" y="${y + 4}" fill="red" font-size="14" font-weight="bold">${i + 1}</text>
    `;
    })
    .join("\n");

  const svgOverlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      ${crossesSvg}
    </svg>`,
  );

  const markedBuffer = await sharp(imgBuffer)
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .jpeg({ quality: 75 })
    .toBuffer();

  return buildResult(markedBuffer, w, h, sessionId);
}
