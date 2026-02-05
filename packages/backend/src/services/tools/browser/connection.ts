import { chromium } from "patchright";
import type { Browser, BrowserContext, CDPSession, Page } from "patchright";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "../../../config/env.js";
import type { ElementRef } from "./types.js";

const execAsync = promisify(exec);

// Path to docker/browser relative to this file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DOCKER_DIR = path.resolve(__dirname, "../../../../../../docker/browser");

/** Start the browser container if not running. Idempotent. */
async function ensureBrowserContainer(): Promise<void> {
  console.log("[Browser] Starting browser container...");
  try {
    await execAsync("docker compose up -d", { cwd: BROWSER_DOCKER_DIR });
    // Wait for the service to be ready
    const maxAttempts = 30;
    const delayMs = 1000;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const { stdout } = await execAsync(
          'docker compose ps --format "{{.State}}"',
          { cwd: BROWSER_DOCKER_DIR }
        );
        if (stdout.trim() === "running") {
          console.log("[Browser] Container is running");
          // Give the browser server a moment to start accepting connections
          await new Promise((r) => setTimeout(r, 2000));
          return;
        }
      } catch {
        // ignore, retry
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error("Browser container failed to start within timeout");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to start browser container: ${msg}`);
  }
}

class BrowserConnection {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private connectPromise: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private cdpSession: CDPSession | null = null;
  private _elementMap: Map<number, ElementRef> = new Map();
  private _mapVersion: number = 0;
  private wsEndpointOverride: string | null = null;

  /** Returns true if a browser connection is active. */
  get isConnected(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  get elementMap(): Map<number, ElementRef> {
    return this._elementMap;
  }

  get mapVersion(): number {
    return this._mapVersion;
  }

  /** Get the active page, auto-connecting if needed. */
  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed() && this.isConnected) {
      this.touchIdle();
      return this.page;
    }

    // Need to (re)connect
    if (this.connectPromise) {
      await this.connectPromise;
      this.touchIdle();
      return this.page!;
    }

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }

    this.touchIdle();
    return this.page!;
  }

  /** Get or create a CDPSession for the active page. */
  async getCDPSession(): Promise<CDPSession> {
    if (this.cdpSession) return this.cdpSession;
    if (!this.context || !this.page) {
      throw new Error("No active browser connection");
    }
    this.cdpSession = await this.context.newCDPSession(this.page);
    // Enable accessibility domain eagerly so the browser starts computing
    // the tree immediately, rather than on the first getFullAXTree call.
    await this.cdpSession.send("Accessibility.enable");
    return this.cdpSession;
  }

  /** Replace the element map with new elements from get_content. */
  updateElementMap(elements: Map<number, ElementRef>): void {
    this._mapVersion++;
    this._elementMap = elements;
    for (const el of elements.values()) {
      el.mapVersion = this._mapVersion;
    }
  }

  /** Clear element map and invalidate CDP session (called on navigation). */
  clearElementMap(): void {
    this._elementMap.clear();
    this._mapVersion++;
    // After a cross-document navigation all CDP domain states are reset.
    // Discard the old session so a fresh one is created on next use.
    if (this.cdpSession) {
      this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }
  }

  /** Resolve an element index to an ElementRef, with error detection. */
  resolveElement(index: number): ElementRef {
    const el = this._elementMap.get(index);
    if (!el) {
      if (this._elementMap.size === 0) {
        throw new ElementNotFoundError(
          `Element [${index}] not found. Call browser_get_content() first to discover elements.`,
        );
      }
      throw new ElementNotFoundError(
        `Element [${index}] not found in current tree (${this._elementMap.size} elements). ` +
          `Call browser_get_content() to refresh.`,
      );
    }
    return el;
  }

  /** Disconnect any existing connection and connect fresh, optionally to a new endpoint. */
  async forceConnect(wsEndpoint?: string): Promise<Page> {
    this.disconnect();
    // Explicit endpoint → store it for future auto-reconnects.
    // No endpoint → reset to default.
    this.wsEndpointOverride = wsEndpoint ?? null;
    return this.getPage();
  }

  private async doConnect(): Promise<void> {
    // Clean up any stale state
    this.cleanup();

    const endpoint = this.wsEndpointOverride ?? env.BROWSER_WS_ENDPOINT;
    const isCustomEndpoint = this.wsEndpointOverride !== null;

    const attemptConnect = async (): Promise<Browser> => {
      // Custom endpoint → connectOverCDP (CDP debugging port).
      // Default endpoint → connect (Playwright WS).
      if (isCustomEndpoint) {
        const cdpUrl = endpoint.startsWith("http://") || endpoint.startsWith("https://")
          ? endpoint
          : `http://${endpoint}`;
        return chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
      } else {
        return chromium.connect(endpoint, { timeout: 15_000 });
      }
    };

    try {
      this.browser = await attemptConnect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isCustomEndpoint) {
        throw new Error(`Failed to connect to browser at ${endpoint}: ${msg}`);
      }
      // Connection refused - try to auto-start the container
      if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        await ensureBrowserContainer();
        // Retry connection after starting container
        try {
          this.browser = await attemptConnect();
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new Error(`Failed to connect to browser after starting container: ${retryMsg}`);
        }
      } else {
        throw new Error(`Failed to connect to browser at ${endpoint}: ${msg}`);
      }
    }

    // Listen for unexpected disconnects
    this.browser.on("disconnected", () => {
      console.log("[Browser] Browser disconnected unexpectedly");
      this.cleanup();
    });

    // Get or create a context (viewport is null to use window size)
    const contexts = this.browser.contexts();
    this.context = contexts.length > 0
      ? contexts[0]
      : await this.browser.newContext({ viewport: null });

    // Get or create a page
    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();

    console.log("[Browser] Connected to browser server");
  }

  /** Disconnect from the browser. Container keeps running. */
  disconnect(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.browser) {
      console.log("[Browser] Disconnecting from browser server");
      // browser.close() terminates the browser process.
      // We just want to drop the WS connection, so use internal disconnect if available.
      // In Patchright/Playwright, there's no "detach" — close() is what we have.
      // Since the server keeps Chrome running, we just drop the connection object.
      try {
        this.browser.close().catch(() => {});
      } catch {
        // ignore
      }
    }

    this.cleanup();
  }

  private cleanup(): void {
    if (this.cdpSession) {
      this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }
    this._elementMap.clear();
    this._mapVersion = 0;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const seconds = env.BROWSER_IDLE_TIMEOUT;
    if (seconds <= 0) return;
    this.idleTimer = setTimeout(() => {
      console.log(`[Browser] Idle timeout (${seconds}s), disconnecting`);
      this.disconnect();
    }, seconds * 1000);
  }
}

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

// --- Singleton ---

let connection: BrowserConnection | null = null;

function getConnection(): BrowserConnection {
  if (!connection) {
    connection = new BrowserConnection();
  }
  return connection;
}

/** Get the active browser page, auto-connecting if needed. */
export async function getBrowserPage(): Promise<Page> {
  return getConnection().getPage();
}

/** Get or create a CDPSession for the active page. */
export async function getCDPSession(): Promise<CDPSession> {
  return getConnection().getCDPSession();
}

/** Check if there is an active browser connection. */
export function isBrowserConnected(): boolean {
  return connection?.isConnected ?? false;
}

/** Disconnect from the browser. */
export function disconnectBrowser(): void {
  connection?.disconnect();
}

/** Disconnect any existing connection and connect fresh, optionally to a new endpoint. */
export async function reconnectBrowser(wsEndpoint?: string): Promise<Page> {
  return getConnection().forceConnect(wsEndpoint);
}

/** Replace the element map after a get_content call. */
export function updateElementMap(elements: Map<number, ElementRef>): void {
  getConnection().updateElementMap(elements);
}

/** Clear the element map (e.g. after navigation). */
export function clearElementMap(): void {
  getConnection().clearElementMap();
}

/** Resolve an element index to its ElementRef. Throws on not found. */
export function resolveElement(index: number): ElementRef {
  return getConnection().resolveElement(index);
}

/**
 * Verify that an element still exists in the DOM.
 * Returns true if element exists, false if it's stale/removed.
 */
export async function verifyElementExists(backendNodeId: number): Promise<boolean> {
  try {
    const cdp = await getCDPSession();
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
