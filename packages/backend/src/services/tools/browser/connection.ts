import type { CDPSession, Page } from "patchright";
import type { ElementRef } from "./types.js";
import { browserSessionManager } from "./BrowserSessionManager.js";

/** Thrown when an element index is not in the current element map. */
export class ElementNotFoundError extends Error {
  readonly code = "ELEMENT_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "ElementNotFoundError";
  }
}

/** Thrown when a CDP operation targets a node that no longer exists. */
export class StaleElementError extends Error {
  readonly code = "STALE_ELEMENT";
  constructor(index: number) {
    super(
      `Element [${index}] no longer exists. Call browser_get_content() to refresh.`,
    );
    this.name = "StaleElementError";
  }
}

/** Get the active browser page for a session, auto-creating if needed. */
export async function getBrowserPage(sessionId: string): Promise<Page> {
  const session = await browserSessionManager.getOrCreate(sessionId);
  return session.page;
}

/** Get or create a CDPSession for a session's active page. */
export async function getCDPSession(sessionId: string): Promise<CDPSession> {
  const session = await browserSessionManager.getOrCreate(sessionId);
  if (session.cdpSession) return session.cdpSession;

  session.cdpSession = await session.context.newCDPSession(session.page);
  // Enable accessibility domain eagerly so the browser starts computing
  // the tree immediately, rather than on the first getFullAXTree call.
  await session.cdpSession.send("Accessibility.enable");
  return session.cdpSession;
}

/** Check if there is an active browser for a session. */
export function isBrowserConnected(sessionId: string): boolean {
  const session = browserSessionManager.get(sessionId);
  return session ? session.browser.isConnected() : false;
}

/** Destroy a session's browser infrastructure. */
export function disconnectBrowser(sessionId: string): void {
  browserSessionManager.destroy(sessionId).catch((err) => {
    console.error(`[Browser] Error disconnecting session ${sessionId}:`, err);
  });
}

/** Destroy and recreate a session's browser. */
export async function reconnectBrowser(sessionId: string, wsEndpoint?: string): Promise<Page> {
  // If a custom endpoint is requested, we don't support per-session display for that.
  // Destroy and recreate.
  await browserSessionManager.destroy(sessionId);
  const session = await browserSessionManager.getOrCreate(sessionId);
  if (wsEndpoint) {
    session.wsEndpointOverride = wsEndpoint;
  }
  return session.page;
}

/** Replace the element map for a session after a get_content call. */
export function updateElementMap(sessionId: string, elements: Map<number, ElementRef>): void {
  const session = browserSessionManager.get(sessionId);
  if (!session) return;

  session.mapVersion++;
  session.elementMap = elements;
  for (const el of elements.values()) {
    el.mapVersion = session.mapVersion;
  }
}

/** Clear the element map for a session (e.g. after navigation). */
export function clearElementMap(sessionId: string): void {
  const session = browserSessionManager.get(sessionId);
  if (!session) return;

  session.elementMap.clear();
  session.mapVersion++;
  // After a cross-document navigation all CDP domain states are reset.
  // Discard the old session so a fresh one is created on next use.
  if (session.cdpSession) {
    session.cdpSession.detach().catch(() => {});
    session.cdpSession = null;
  }
}

/** Resolve an element index to its ElementRef for a session. Throws on not found. */
export function resolveElement(sessionId: string, index: number): ElementRef {
  const session = browserSessionManager.get(sessionId);
  const elementMap = session?.elementMap ?? new Map();

  const el = elementMap.get(index);
  if (!el) {
    if (elementMap.size === 0) {
      throw new ElementNotFoundError(
        `Element [${index}] not found. Call browser_get_content() first to discover elements.`,
      );
    }
    throw new ElementNotFoundError(
      `Element [${index}] not found in current tree (${elementMap.size} elements). ` +
        `Call browser_get_content() to refresh.`,
    );
  }
  return el;
}

/**
 * Verify that an element still exists in the DOM for a session.
 * Returns true if element exists, false if it's stale/removed.
 */
export async function verifyElementExists(sessionId: string, backendNodeId: number): Promise<boolean> {
  try {
    const cdp = await getCDPSession(sessionId);
    // Try to resolve the backend node to a remote object
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId }) as { object?: { objectId?: string } };
    if (!object?.objectId) return false;
    // Release the object immediately
    await cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Clean up all browser resources for a session. */
export async function cleanupBrowserSession(sessionId: string): Promise<void> {
  await browserSessionManager.destroy(sessionId);
}

/** Get list of session IDs with active browser infrastructure. */
export function getActiveBrowserSessions(): string[] {
  return browserSessionManager.getActiveSessions();
}
