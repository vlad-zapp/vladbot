import { getBrowserPage, clearElementMap } from "../connection.js";
import { saveSessionFile } from "../../../sessionFiles.js";
import type { BrowserNavigateResult } from "../types.js";
import type { Response } from "patchright";

export async function navigate(args: Record<string, unknown>, sessionId?: string): Promise<string> {
  const url = args.url as string;
  if (!url) throw new Error("Missing required argument: url");

  const waitUntil = (args.wait_until as string) || "domcontentloaded";
  if (!["load", "domcontentloaded", "networkidle"].includes(waitUntil)) {
    throw new Error(`Invalid wait_until value: ${waitUntil}. Must be "load", "domcontentloaded", or "networkidle".`);
  }

  const page = await getBrowserPage();
  const targetHost = new URL(url).host;

  // Track document responses - some sites return 429/403 initially then reload via JS
  let lastDocumentStatus: number | null = null;
  const responseHandler = (res: Response) => {
    try {
      const resUrl = new URL(res.url());
      if (resUrl.host === targetHost && res.request().resourceType() === "document") {
        lastDocumentStatus = res.status();
      }
    } catch {
      // ignore invalid URLs
    }
  };

  page.on("response", responseHandler);

  try {
    const response = await page.goto(url, {
      waitUntil: waitUntil as "load" | "domcontentloaded" | "networkidle",
      timeout: 30_000,
    });

    // Wait a bit for any JS-triggered reloads to complete
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});

    // Navigation invalidates the element map
    clearElementMap();

    const title = await page.title();
    // Use the last document response status (handles JS reloads), fallback to initial
    const status = lastDocumentStatus ?? response?.status() ?? null;

    // Take a screenshot of the loaded page
    const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 75 });

    const result: BrowserNavigateResult = {
      type: "browser_navigate",
      url: page.url(),
      title,
      status,
    };

    if (sessionId) {
      const filename = saveSessionFile(sessionId, Buffer.from(screenshotBuffer), "jpg");
      result.image_url = `/api/sessions/${sessionId}/files/${filename}`;
    } else {
      result.image_base64 = `data:image/jpeg;base64,${Buffer.from(screenshotBuffer).toString("base64")}`;
    }

    return JSON.stringify(result);
  } finally {
    page.off("response", responseHandler);
  }
}
