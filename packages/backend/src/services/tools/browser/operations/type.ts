import {
  getBrowserPage,
  resolveElement,
  verifyElementExists,
  StaleElementError,
} from "../connection.js";
import type { BrowserTypeResult } from "../types.js";
import { takeMarkerScreenshot } from "./markerScreenshot.js";
import { scrollElementIntoView } from "./scrollIntoView.js";

export async function typeText(args: Record<string, unknown>, sessionId?: string): Promise<string> {
  const text = args.text as string;
  if (!text) throw new Error("Missing required argument: text");

  const elementIndex = args.element as number | undefined;
  const clearFirst = (args.clear_first as boolean) ?? true;

  const page = await getBrowserPage();
  let elementRole: string | undefined;
  let elementName: string | undefined;

  let screenshot: { image_url?: string; image_base64?: string } | undefined;

  // Focus the target element by clicking it
  if (elementIndex !== undefined) {
    const el = resolveElement(elementIndex);
    elementRole = el.role;
    elementName = el.name;

    // Scroll element into view with human-like behavior
    const coords = await scrollElementIntoView(el.backendDOMNodeId);
    if (!coords) {
      throw new StaleElementError(elementIndex);
    }

    // Verify element still exists right before clicking (minimizes time gap)
    const exists = await verifyElementExists(el.backendDOMNodeId);
    if (!exists) {
      throw new StaleElementError(elementIndex);
    }

    // Add small random offset for natural clicking
    const x = coords.x + (Math.random() - 0.5) * 6;
    const y = coords.y + (Math.random() - 0.5) * 6;

    // Take screenshot with marker before clicking
    screenshot = await takeMarkerScreenshot(x, y, sessionId);

    await page.mouse.click(x, y);
  }
  // If no element specified, type into currently focused element

  if (clearFirst) {
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
  }

  await page.keyboard.type(text, { delay: 30 + Math.random() * 40 });

  const result: BrowserTypeResult = {
    type: "browser_type",
    success: true,
    typed: text,
    element_role: elementRole,
    element_name: elementName,
    ...screenshot,
  };

  return JSON.stringify(result);
}
