import { getBrowserPage } from "../connection.js";
import type { BrowserJsResult } from "../types.js";

export async function executeJs(args: Record<string, unknown>, sessionId?: string): Promise<string> {
  const script = args.script as string;
  if (!script) throw new Error("Missing required argument: script");

  const page = await getBrowserPage(sessionId!);

  let returnValue: unknown;
  try {
    // Wrap in an async IIFE so the user can use await
    returnValue = await page.evaluate(`(async () => { ${script} })()`);
  } catch (err) {
    throw new Error(
      `JavaScript execution error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result: BrowserJsResult = {
    type: "browser_js",
    result: returnValue ?? null,
  };

  return JSON.stringify(result);
}
