import {
  getBrowserPage,
  resolveElement,
  verifyElementExists,
  StaleElementError,
} from "../connection.js";
import type { BrowserClickResult } from "../types.js";
import { takeMarkerScreenshot } from "./markerScreenshot.js";
import { scrollElementIntoView } from "./scrollIntoView.js";

export async function click(args: Record<string, unknown>, sessionId?: string): Promise<string> {
  const elementIndex = args.element as number | undefined;
  const rawX = args.x as number | undefined;
  const rawY = args.y as number | undefined;
  const button = (args.button as "left" | "right" | "middle") || "left";
  const clickCount = Number(args.click_count) || 1;

  const page = await getBrowserPage(sessionId!);
  let x: number;
  let y: number;
  let elementRole: string | undefined;
  let elementName: string | undefined;

  if (elementIndex !== undefined) {
    const el = resolveElement(sessionId!, elementIndex);
    elementRole = el.role;
    elementName = el.name;

    // Scroll element into view with human-like behavior
    const coords = await scrollElementIntoView(el.backendDOMNodeId, sessionId);
    if (!coords) {
      throw new StaleElementError(elementIndex);
    }

    // Verify element still exists right before clicking (minimizes time gap)
    const exists = await verifyElementExists(sessionId!, el.backendDOMNodeId);
    if (!exists) {
      throw new StaleElementError(elementIndex);
    }

    // Add small random offset within element for natural clicking
    x = coords.x + (Math.random() - 0.5) * 10;
    y = coords.y + (Math.random() - 0.5) * 10;
  } else if (rawX !== undefined && rawY !== undefined) {
    x = rawX;
    y = rawY;
  } else {
    throw new Error(
      "click requires element index (from get_content) or x+y coordinates. Call get_content first to discover elements.",
    );
  }

  // Take screenshot with marker before clicking
  const screenshot = await takeMarkerScreenshot(x, y, sessionId);

  await page.mouse.click(x, y, {
    button,
    clickCount,
    delay: 30 + Math.random() * 50,
  });

  const result: BrowserClickResult = {
    type: "browser_click",
    success: true,
    clicked_at: { x: Math.round(x), y: Math.round(y) },
    element_role: elementRole,
    element_name: elementName,
    ...screenshot,
  };

  return JSON.stringify(result);
}
