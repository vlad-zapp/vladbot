import { getBrowserPage } from "../connection.js";
import { saveSessionFile } from "../../../sessionFiles.js";
import type { BrowserScreenshotResult } from "../types.js";

export async function screenshot(
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<string> {
  const selector = args.selector as string | undefined;

  const page = await getBrowserPage(sessionId!);

  let buffer: Buffer;
  if (selector) {
    const element = await page.$(selector);
    if (!element) throw new Error(`Element not found: ${selector}`);
    buffer = await element.screenshot({ type: "jpeg", quality: 75 });
  } else {
    buffer = await page.screenshot({ type: "jpeg", quality: 75 });
  }

  const viewport = page.viewportSize();
  const result: BrowserScreenshotResult = {
    type: "browser_screenshot",
    width: viewport?.width ?? 1920,
    height: viewport?.height ?? 1080,
    url: page.url(),
    title: await page.title(),
  };

  if (sessionId) {
    const filename = saveSessionFile(sessionId, Buffer.from(buffer), "jpg");
    result.image_url = `/api/sessions/${sessionId}/files/${filename}`;
  } else {
    result.image_base64 = `data:image/jpeg;base64,${Buffer.from(buffer).toString("base64")}`;
  }

  return JSON.stringify(result);
}
