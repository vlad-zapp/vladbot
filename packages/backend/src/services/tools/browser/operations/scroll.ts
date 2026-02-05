import {
  getBrowserPage,
  getCDPSession,
  resolveElement,
  StaleElementError,
} from "../connection.js";
import type { BrowserScrollResult } from "../types.js";

export async function scroll(args: Record<string, unknown>): Promise<string> {
  const direction = (args.direction as string) || "down";
  const amount = args.amount as string | number | undefined;
  const toElement = args.to_element as number | undefined;

  if (!["up", "down"].includes(direction)) {
    throw new Error(
      `Invalid direction: ${direction}. Must be "up" or "down".`,
    );
  }

  const page = await getBrowserPage();

  if (toElement !== undefined) {
    const el = resolveElement(toElement);
    const cdp = await getCDPSession();

    try {
      await cdp.send("DOM.scrollIntoViewIfNeeded", {
        backendNodeId: el.backendDOMNodeId,
      });
    } catch {
      throw new StaleElementError(toElement);
    }

    let scrolledTo: { x: number; y: number } | undefined;
    try {
      const result = await cdp.send("DOM.getBoxModel", {
        backendNodeId: el.backendDOMNodeId,
      });
      const model = (result as { model: { content: number[] } }).model;
      scrolledTo = {
        x: Math.round(
          (model.content[0] + model.content[2] + model.content[4] + model.content[6]) / 4,
        ),
        y: Math.round(
          (model.content[1] + model.content[3] + model.content[5] + model.content[7]) / 4,
        ),
      };
    } catch {
      // Box model failed but scroll may have worked — continue
    }

    const result: BrowserScrollResult = {
      type: "browser_scroll",
      direction: direction as "up" | "down",
      amount: `to_element [${toElement}]`,
      scrolled_to: scrolledTo,
    };
    return JSON.stringify(result);
  }

  // Calculate scroll distance
  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 };
  let pixels: number;
  if (amount === "page") {
    pixels = viewport.height;
  } else if (amount === "half") {
    pixels = viewport.height / 2;
  } else if (typeof amount === "number") {
    pixels = amount;
  } else {
    pixels = viewport.height; // default: one page
  }

  const scrollY = direction === "down" ? pixels : -pixels;
  await page.mouse.wheel(0, scrollY);
  // Small delay for scroll to settle
  await new Promise((r) => setTimeout(r, 200));

  const result: BrowserScrollResult = {
    type: "browser_scroll",
    direction: direction as "up" | "down",
    amount: String(amount ?? "page"),
  };

  return JSON.stringify(result);
}
