import { chromium } from "patchright";
import type { Browser, BrowserContext, CDPSession, Page } from "patchright";
import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { userInfo } from "os";
import { env } from "../../../config/env.js";
import type { ElementRef } from "./types.js";

const VNC_TOKENS_DIR = process.env.VNC_TOKENS_DIR || "/data/vnc-tokens";

export interface ManagedSession {
  sessionId: string;
  displayNum: number;
  vncPort: number;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdpSession: CDPSession | null;
  elementMap: Map<number, ElementRef>;
  mapVersion: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  xvfbProcess: ChildProcess;
  x11vncProcess: ChildProcess;
  wsEndpointOverride: string | null;
}

/**
 * Wait for an X display socket to appear.
 * Xvfb creates /tmp/.X11-unix/XN when ready.
 */
async function waitForDisplay(displayNum: number, timeoutMs = 10_000): Promise<void> {
  const socketPath = `/tmp/.X11-unix/X${displayNum}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(socketPath)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Xvfb display :${displayNum} did not start within ${timeoutMs}ms`);
}

/**
 * Manages per-session browser infrastructure: Xvfb, Chrome, x11vnc.
 * Sessions are created lazily on first browser tool use and destroyed
 * on session delete or idle timeout (default 5 minutes).
 */
class BrowserSessionManager {
  private sessions = new Map<string, ManagedSession>();
  private nextDisplayNum = 100;
  /** Track which display numbers are in use so we can reclaim them. */
  private usedDisplayNums = new Set<number>();

  /**
   * Get an existing session or create a new one.
   * Resets the idle timer on each call.
   */
  async getOrCreate(sessionId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.browser.isConnected() && !existing.page.isClosed()) {
      this.touchIdle(sessionId);
      return existing;
    }

    // If there was a stale entry, clean it up first
    if (existing) {
      await this.destroy(sessionId);
    }

    return this.create(sessionId);
  }

  /**
   * Destroy a session's browser infrastructure.
   * Safe to call even if session doesn't exist.
   */
  async destroy(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Clear idle timer
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    // Close browser resources
    if (session.cdpSession) {
      session.cdpSession.detach().catch(() => {});
    }

    try {
      await session.browser.close();
    } catch {
      // ignore close errors
    }

    // Kill child processes
    this.killProcess(session.x11vncProcess);
    this.killProcess(session.xvfbProcess);

    // Remove websockify token file
    try {
      unlinkSync(`${VNC_TOKENS_DIR}/${sessionId}`);
    } catch {
      // ignore if file doesn't exist
    }

    // Reclaim display number
    this.usedDisplayNums.delete(session.displayNum);

    this.sessions.delete(sessionId);
    console.log(`[BrowserSession] Destroyed session ${sessionId} (display :${session.displayNum})`);
  }

  /**
   * Get list of active session IDs with browser infra running.
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Check if a session has active browser infrastructure.
   */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get a session without creating it. Returns undefined if not active.
   */
  get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Reset the idle timer for a session.
   */
  touchIdle(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }

    const timeoutSecs = env.BROWSER_IDLE_TIMEOUT;
    if (timeoutSecs <= 0) return;

    session.idleTimer = setTimeout(() => {
      console.log(`[BrowserSession] Session ${sessionId} idle timeout (${timeoutSecs}s), destroying`);
      this.destroy(sessionId).catch((err) => {
        console.error(`[BrowserSession] Error destroying idle session ${sessionId}:`, err);
      });
    }, timeoutSecs * 1000);
  }

  /**
   * Destroy all sessions. Called on process shutdown.
   */
  async destroyAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }

  private allocateDisplayNum(): number {
    let num = this.nextDisplayNum;
    while (this.usedDisplayNums.has(num)) {
      num++;
    }
    this.usedDisplayNums.add(num);
    this.nextDisplayNum = num + 1;
    return num;
  }

  private async create(sessionId: string): Promise<ManagedSession> {
    const displayNum = this.allocateDisplayNum();
    const vncPort = 5900 + displayNum;

    console.log(`[BrowserSession] Creating session ${sessionId} on display :${displayNum}, VNC port ${vncPort}`);

    // 1. Start Xvfb
    const xvfbProcess = spawn("Xvfb", [
      `:${displayNum}`,
      "-screen", "0", "1920x1080x24",
      "-ac",
    ], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    });

    xvfbProcess.on("error", (err) => {
      console.error(`[BrowserSession] Xvfb error for session ${sessionId}:`, err);
    });

    // Log Xvfb stderr for debugging
    if (xvfbProcess.stderr) {
      xvfbProcess.stderr.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[BrowserSession] Xvfb stderr (display :${displayNum}): ${msg}`);
      });
    }

    xvfbProcess.on("exit", (code, signal) => {
      console.log(`[BrowserSession] Xvfb exited for display :${displayNum} (code=${code}, signal=${signal})`);
    });

    try {
      // 2. Wait for display to be ready
      await waitForDisplay(displayNum);

      // 3. Launch Chrome on this display
      const browser = await chromium.launch({
        headless: false,
        channel: "chrome",
        env: { ...process.env, DISPLAY: `:${displayNum}`, HOME: userInfo().homedir },
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--start-maximized",
          "--window-size=1920,1080",
          "--window-position=0,0",
        ],
      });

      // 4. Start x11vnc for this display
      const x11vncProcess = spawn("x11vnc", [
        "-display", `:${displayNum}`,
        "-forever",
        "-shared",
        "-rfbport", String(vncPort),
        "-nopw",
        "-noxdamage",
      ], {
        stdio: ["ignore", "ignore", "pipe"],
        detached: false,
      });

      x11vncProcess.on("error", (err) => {
        console.error(`[BrowserSession] x11vnc error for session ${sessionId}:`, err);
      });

      if (x11vncProcess.stderr) {
        x11vncProcess.stderr.on("data", (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) console.log(`[BrowserSession] x11vnc stderr (display :${displayNum}): ${msg}`);
        });
      }

      x11vncProcess.on("exit", (code, signal) => {
        console.log(`[BrowserSession] x11vnc exited for display :${displayNum} (code=${code}, signal=${signal})`);
      });

      // 5. Write websockify token file (format: "token: host:port")
      try {
        writeFileSync(`${VNC_TOKENS_DIR}/${sessionId}`, `${sessionId}: localhost:${vncPort}`);
      } catch {
        // May fail outside Docker — that's OK
      }

      // 6. Create context + page
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();

      // Listen for unexpected disconnects
      browser.on("disconnected", () => {
        console.log(`[BrowserSession] Browser disconnected for session ${sessionId}`);
        // Clean up without trying to close the browser again
        const s = this.sessions.get(sessionId);
        if (s) {
          if (s.idleTimer) clearTimeout(s.idleTimer);
          this.killProcess(s.x11vncProcess);
          this.killProcess(s.xvfbProcess);
          try { unlinkSync(`${VNC_TOKENS_DIR}/${sessionId}`); } catch {}
          this.usedDisplayNums.delete(s.displayNum);
          this.sessions.delete(sessionId);
        }
      });

      const session: ManagedSession = {
        sessionId,
        displayNum,
        vncPort,
        browser,
        context,
        page,
        cdpSession: null,
        elementMap: new Map(),
        mapVersion: 0,
        idleTimer: null,
        xvfbProcess,
        x11vncProcess,
        wsEndpointOverride: null,
      };

      this.sessions.set(sessionId, session);
      this.touchIdle(sessionId);

      console.log(`[BrowserSession] Session ${sessionId} ready (display :${displayNum})`);
      return session;
    } catch (err) {
      // Cleanup on failure
      this.killProcess(xvfbProcess);
      this.usedDisplayNums.delete(displayNum);
      throw err;
    }
  }

  private killProcess(proc: ChildProcess): void {
    try {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        // Force kill after 2 seconds if still alive
        setTimeout(() => {
          try {
            if (proc.exitCode === null) proc.kill("SIGKILL");
          } catch {}
        }, 2000);
      }
    } catch {
      // ignore
    }
  }
}

export const browserSessionManager = new BrowserSessionManager();

// Cleanup on process exit
process.on("SIGTERM", () => {
  browserSessionManager.destroyAll().catch(console.error);
});
process.on("SIGINT", () => {
  browserSessionManager.destroyAll().catch(console.error);
});
