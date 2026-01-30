import rfb from "rfb2";
import sharp from "sharp";
import { env } from "../../../config/env.js";

export interface VncTarget {
  host: string;
  port: number;
  password?: string;
}

interface RfbRect {
  x: number;
  y: number;
  width: number;
  height: number;
  encoding: number;
  data?: Buffer;
  src?: { x: number; y: number };
}

interface RfbClient {
  width: number;
  height: number;
  bpp: number;
  depth: number;
  redShift: number;
  greenShift: number;
  blueShift: number;
  title: string;
  autoUpdate: boolean;
  pointerEvent(x: number, y: number, buttons: number): void;
  keyEvent(keysym: number, isDown: boolean | number): void;
  requestUpdate(
    incremental: boolean,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void;
  end(): void;
  on(event: "connect", cb: () => void): void;
  on(event: "rect", cb: (rect: RfbRect) => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
  on(event: "resize", cb: (rect: RfbRect) => void): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

class VncConnection {
  private client: RfbClient | null = null;
  private framebuffer: Buffer | null = null;
  private connectPromise: Promise<void> | null = null;
  private rectCallback: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onIdle: (() => void) | null = null;

  constructor(private readonly target: VncTarget) {}

  /** Register a callback invoked when the idle timeout fires. */
  setOnIdle(cb: () => void): void {
    this.onIdle = cb;
  }

  /** Reset (or start) the idle timer. Called on every operation. */
  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const seconds = env.VNC_CONNECTION_TIMEOUT;
    if (seconds <= 0) return; // disabled
    this.idleTimer = setTimeout(() => {
      console.log(
        `[VNC] Idle timeout (${seconds}s), disconnecting ${this.target.host}:${this.target.port}`,
      );
      this.disconnect();
      this.onIdle?.();
    }, seconds * 1000);
  }

  /** Called by the rect event handler to notify waiters. */
  private onRect(): void {
    this.rectCallback?.();
  }

  /**
   * Returns a promise that resolves once rect events stop arriving
   * (debounce: resolves after 200ms of silence, or 10s max).
   * Resolves to `true` if at least one rect arrived, `false` on timeout.
   */
  private waitForRects(): Promise<boolean> {
    return new Promise((resolve) => {
      let debounce: ReturnType<typeof setTimeout>;
      let fallbackTimer: ReturnType<typeof setTimeout>;
      let received = false;

      const settle = () => {
        received = true;
        clearTimeout(debounce);
        debounce = setTimeout(done, 200);
      };

      const done = () => {
        clearTimeout(debounce);
        clearTimeout(fallbackTimer);
        this.rectCallback = null;
        resolve(received);
      };

      this.rectCallback = settle;

      // Fallback: resolve after 10s no matter what
      fallbackTimer = setTimeout(done, 10_000);
    });
  }

  async getClient(): Promise<RfbClient> {
    if (this.client) {
      this.touchIdle();
      return this.client;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      this.touchIdle();
      return this.client!;
    }
    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
    this.touchIdle();
    return this.client!;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = rfb.createConnection({
        host: this.target.host,
        port: this.target.port,
        password: this.target.password || undefined,
      }) as unknown as RfbClient;

      let initialResponseReceived = false;
      let settled = false;
      const target = `${this.target.host}:${this.target.port}`;

      // rfb2 throws inside callbacks for unsupported security types and
      // missing passwords. These become uncaughtExceptions, not 'error'
      // events. We catch only rfb2-specific messages and re-throw the rest.
      const rfb2Patterns = [
        "Server requires VNC security",
        "Server does not support any security",
        "unknown security type",
      ];
      const onUncaught = (err: Error) => {
        if (rfb2Patterns.some((p) => err.message?.includes(p))) {
          fail(new Error(`VNC error (${target}): ${err.message}`));
        } else {
          // Not ours — re-throw so other handlers / default behavior works
          cleanup();
          throw err;
        }
      };
      process.on("uncaughtException", onUncaught);
      const cleanup = () => {
        process.removeListener("uncaughtException", onUncaught);
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        clearTimeout(connectTimeout);
        try { client.end(); } catch { /* ignore */ }
        reject(err);
      };

      const connectTimeout = setTimeout(() => {
        fail(new Error(
          `VNC connection to ${target} timed out after 15s`
          + " (possible causes: host unreachable, auth handshake stall, unsupported security type)",
        ));
      }, 15_000);

      const resolveWhenReady = () => {
        if (initialResponseReceived) return;
        initialResponseReceived = true;
        if (!settled) {
          settled = true;
          cleanup();
          clearTimeout(connectTimeout);
          resolve();
        }
      };

      // Access the underlying TCP socket to detect silent disconnects
      // (e.g. server closes connection after auth failure without sending
      // an error message through the VNC protocol).
      const socket = (client as unknown as { stream: import("net").Socket }).stream;
      if (socket && typeof socket.on === "function") {
        socket.on("close", () => {
          fail(new Error(
            `VNC connection to ${target} was closed by the server`
            + " (likely authentication failure — check password and that the server supports VNC auth)",
          ));
        });
      }

      client.on("connect", () => {
        cleanup();
        this.client = client;
        const bytesPerPixel = client.bpp >> 3;
        this.framebuffer = Buffer.alloc(
          client.width * client.height * bytesPerPixel,
        );

        // Enable autoUpdate so rfb2 continuously requests incremental
        // frames after each fbUpdate. This keeps the internal state machine
        // (expectNewMessage loop) alive and the framebuffer fresh.
        // Without this, if the server sends an unsupported encoding the
        // state machine breaks permanently and all subsequent requests
        // go unanswered.
        client.autoUpdate = true;

        setTimeout(resolveWhenReady, 500);
      });

      client.on("rect", (rect: RfbRect) => {
        if (rect.data) {
          this.updateFramebuffer(rect);
        }
        if (rect.src && this.framebuffer && this.client) {
          this.copyFramebufferRegion(rect);
        }
        resolveWhenReady();
        this.onRect();
      });

      client.on("resize", (rect: RfbRect) => {
        const c = this.client ?? client;
        const bytesPerPixel = c.bpp >> 3;
        this.framebuffer = Buffer.alloc(
          rect.width * rect.height * bytesPerPixel,
        );
        resolveWhenReady();
      });

      client.on("error", (err: unknown) => {
        cleanup();
        if (!this.client) {
          const msg = err instanceof Error ? err.message
            : typeof err === "string" ? err
            : JSON.stringify(err);
          fail(new Error(`VNC authentication/connection error (${target}): ${msg}`));
        } else {
          console.error(
            `[VNC] Connection error (${target}):`,
            err,
          );
          this.client = null;
          this.framebuffer = null;
        }
      });
    });
  }

  private updateFramebuffer(rect: RfbRect): void {
    if (!this.framebuffer || !this.client || !rect.data) return;

    const bytesPerPixel = this.client.bpp >> 3;
    const screenWidth = this.client.width;

    for (let row = 0; row < rect.height; row++) {
      const srcOffset = row * rect.width * bytesPerPixel;
      const destOffset =
        ((rect.y + row) * screenWidth + rect.x) * bytesPerPixel;
      rect.data.copy(
        this.framebuffer,
        destOffset,
        srcOffset,
        srcOffset + rect.width * bytesPerPixel,
      );
    }
  }

  private copyFramebufferRegion(rect: RfbRect): void {
    if (!this.framebuffer || !this.client || !rect.src) return;

    const bytesPerPixel = this.client.bpp >> 3;
    const screenWidth = this.client.width;

    const temp = Buffer.alloc(rect.width * rect.height * bytesPerPixel);
    for (let row = 0; row < rect.height; row++) {
      const srcOffset =
        ((rect.src.y + row) * screenWidth + rect.src.x) * bytesPerPixel;
      const tmpOffset = row * rect.width * bytesPerPixel;
      this.framebuffer.copy(
        temp,
        tmpOffset,
        srcOffset,
        srcOffset + rect.width * bytesPerPixel,
      );
    }
    for (let row = 0; row < rect.height; row++) {
      const destOffset =
        ((rect.y + row) * screenWidth + rect.x) * bytesPerPixel;
      const tmpOffset = row * rect.width * bytesPerPixel;
      temp.copy(
        this.framebuffer,
        destOffset,
        tmpOffset,
        tmpOffset + rect.width * bytesPerPixel,
      );
    }
  }

  async takeScreenshot(): Promise<Buffer> {
    const client = await this.getClient(); // also resets idle timer
    if (!this.framebuffer) throw new Error("Framebuffer not initialized");

    await this.requestFullUpdate();

    let rgbaBuffer: Buffer;

    const bytesPerPixel = client.bpp >> 3;
    if (bytesPerPixel === 4) {
      if (
        client.redShift === 16 &&
        client.greenShift === 8 &&
        client.blueShift === 0
      ) {
        // BGRA → RGBA
        rgbaBuffer = Buffer.alloc(this.framebuffer.length);
        for (let i = 0; i < this.framebuffer.length; i += 4) {
          rgbaBuffer[i] = this.framebuffer[i + 2];
          rgbaBuffer[i + 1] = this.framebuffer[i + 1];
          rgbaBuffer[i + 2] = this.framebuffer[i];
          rgbaBuffer[i + 3] = 255;
        }
      } else {
        rgbaBuffer = Buffer.from(this.framebuffer);
        for (let i = 3; i < rgbaBuffer.length; i += 4) {
          rgbaBuffer[i] = 255;
        }
      }
    } else {
      throw new Error(
        `Unsupported pixel format: ${bytesPerPixel} bytes per pixel`,
      );
    }

    return sharp(rgbaBuffer, {
      raw: {
        width: client.width,
        height: client.height,
        channels: 4,
      },
    })
      .jpeg({ quality: 75 })
      .toBuffer();
  }

  private async requestFullUpdate(): Promise<void> {
    if (!this.client) return;

    for (let attempt = 0; attempt < 2; attempt++) {
      this.client.requestUpdate(
        false,
        0,
        0,
        this.client.width,
        this.client.height,
      );
      const received = await this.waitForRects();
      if (received) return;
    }

    // Both attempts failed — rfb2's state machine is likely stuck.
    // Force reconnect and try once more.
    console.warn(
      `[VNC] No rects received after 2 attempts, reconnecting (${this.target.host}:${this.target.port})`,
    );
    this.disconnect();
    await this.getClient();

    if (!this.client) return;
    this.client.requestUpdate(
      false,
      0,
      0,
      this.client.width,
      this.client.height,
    );
    await this.waitForRects();
  }

  get width(): number {
    return this.client?.width ?? 0;
  }

  get height(): number {
    return this.client?.height ?? 0;
  }

  disconnect(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.client) {
      this.client.end();
      this.client = null;
      this.framebuffer = null;
      this.connectPromise = null;
    }
  }
}

// --- Connection pool keyed by host:port ---

const pool = new Map<string, VncConnection>();

function poolKey(target: VncTarget): string {
  return `${target.host}:${target.port}`;
}

export function getVncConnection(target: VncTarget): VncConnection {
  const key = poolKey(target);
  let conn = pool.get(key);
  if (!conn) {
    conn = new VncConnection(target);
    conn.setOnIdle(() => pool.delete(key));
    pool.set(key, conn);
  }
  return conn;
}

/**
 * Extract VNC connection target from tool args.
 * `host` is required; `port` defaults to 5900.
 */
export function resolveTarget(args: Record<string, unknown>): VncTarget {
  const host = args.host as string | undefined;
  if (!host) throw new Error("Missing required argument: host");
  return {
    host,
    port: args.port !== undefined ? Number(args.port) : 5900,
    password: (args.password as string) || undefined,
  };
}

/**
 * Shorthand: extract target from args and return the pooled connection.
 */
export function resolveConnection(
  args: Record<string, unknown>,
): VncConnection {
  return getVncConnection(resolveTarget(args));
}
