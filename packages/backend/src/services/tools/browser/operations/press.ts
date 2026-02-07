import { getBrowserPage } from "../connection.js";
import type { BrowserPressResult } from "../types.js";

export async function pressKey(args: Record<string, unknown>, sessionId?: string): Promise<string> {
  const key = args.key as string;
  if (!key) throw new Error("Missing required argument: key");

  const page = await getBrowserPage(sessionId!);
  await page.keyboard.press(key);

  const result: BrowserPressResult = {
    type: "browser_press",
    success: true,
    key,
  };

  return JSON.stringify(result);
}
