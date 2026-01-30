import type { WsRequest, WsResponse, WsPush, SSEEvent } from "@vladbot/shared";
import { MAX_RETRY_COUNT, DEFAULT_RETRY_COUNT, API_VERSION } from "@vladbot/shared";

const LS_KEY = "ws_retry_count";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 5_000;
const INITIAL_BACKOFF_MS = 100;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type ConnectionListener = (connected: boolean) => void;
type PushListener = (event: SSEEvent) => void;

function getStoredRetryCount(): number {
  try {
    const val = parseInt(localStorage.getItem(LS_KEY) ?? "", 10);
    if (Number.isNaN(val)) return DEFAULT_RETRY_COUNT;
    return Math.max(0, Math.min(MAX_RETRY_COUNT, val));
  } catch {
    return DEFAULT_RETRY_COUNT;
  }
}

export class WsClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, PendingRequest>();
  private pushListeners = new Map<string, Set<PushListener>>();
  private connectionListeners = new Set<ConnectionListener>();
  private retryCount: number;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;

  connected = false;

  constructor(private url: string) {
    this.retryCount = getStoredRetryCount();
    this.connect();
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  private connect(): void {
    if (typeof WebSocket === "undefined") return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.backoff = INITIAL_BACKOFF_MS;

      // Send config.init handshake before notifying listeners,
      // so the handshake goes before any queued requests.
      this.sendRaw({
        seq: this.nextSeq(),
        type: "config.init",
        payload: { version: API_VERSION, retryCount: this.retryCount },
      });

      this.notifyConnectionListeners();
    };

    this.ws.onclose = () => {
      this.handleDisconnect();
    };

    this.ws.onerror = () => {
      // onclose will also fire
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.push === true) {
          this.handlePush(msg as WsPush);
        } else if (typeof msg.seq === "number") {
          this.handleResponse(msg as WsResponse);
        }
      } catch {
        // Ignore malformed messages
      }
    };
  }

  private handleDisconnect(): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;

    // Reject all pending requests
    for (const [seq, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WebSocket disconnected"));
      this.pending.delete(seq);
    }

    if (wasConnected || this.intentionallyClosed) {
      this.notifyConnectionListeners();
    }

    if (!this.intentionallyClosed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private notifyConnectionListeners(): void {
    for (const cb of this.connectionListeners) {
      try { cb(this.connected); } catch { /* ignore */ }
    }
  }

  private nextSeq(): number {
    return ++this.seq;
  }

  private sendRaw(msg: WsRequest): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Response handling
  // ---------------------------------------------------------------------------

  private handleResponse(msg: WsResponse): void {
    const pending = this.pending.get(msg.seq);
    if (!pending) return;
    this.pending.delete(msg.seq);
    clearTimeout(pending.timer);

    if (msg.ok) {
      pending.resolve(msg.data);
    } else {
      const err = new Error(msg.error ?? "Request failed");
      (err as unknown as { status: number }).status = msg.status ?? 500;
      pending.reject(err);
    }
  }

  private handlePush(msg: WsPush): void {
    const listeners = this.pushListeners.get(msg.sessionId);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(msg.event); } catch { /* ignore */ }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  request<T = unknown>(type: string, payload: unknown = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const doSend = () => {
        const seq = this.nextSeq();
        const timer = setTimeout(() => {
          this.pending.delete(seq);
          reject(new Error("Request timed out"));
        }, REQUEST_TIMEOUT_MS);

        this.pending.set(seq, {
          resolve: resolve as (data: unknown) => void,
          reject,
          timer,
        });

        const sent = this.sendRaw({ seq, type, payload });
        if (!sent) {
          this.pending.delete(seq);
          clearTimeout(timer);
          reject(new Error("WebSocket not connected"));
        }
      };

      if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
        doSend();
      } else if (this.intentionallyClosed) {
        reject(new Error("WebSocket not connected"));
      } else {
        // Wait for connection (up to request timeout)
        const timeout = setTimeout(() => {
          unsub();
          reject(new Error("WebSocket not connected"));
        }, REQUEST_TIMEOUT_MS);

        const unsub = this.onConnectionChange((connected) => {
          if (connected) {
            clearTimeout(timeout);
            unsub();
            doSend();
          } else if (this.intentionallyClosed) {
            clearTimeout(timeout);
            unsub();
            reject(new Error("WebSocket not connected"));
          }
        });
      }
    });
  }

  onPush(sessionId: string, callback: PushListener): () => void {
    let listeners = this.pushListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.pushListeners.set(sessionId, listeners);
    }
    listeners.add(callback);

    return () => {
      listeners!.delete(callback);
      if (listeners!.size === 0) {
        this.pushListeners.delete(sessionId);
      }
    };
  }

  onConnectionChange(callback: ConnectionListener): () => void {
    this.connectionListeners.add(callback);
    return () => {
      this.connectionListeners.delete(callback);
    };
  }

  setRetryCount(count: number): void {
    const clamped = Math.max(0, Math.min(MAX_RETRY_COUNT, Math.round(count)));
    this.retryCount = clamped;
    try {
      localStorage.setItem(LS_KEY, String(clamped));
    } catch { /* ignore */ }

    // Update the server
    if (this.connected) {
      this.sendRaw({
        seq: this.nextSeq(),
        type: "config.init",
        payload: { version: API_VERSION, retryCount: clamped },
      });
    }
  }

  getRetryCount(): number {
    return this.retryCount;
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

function buildWsUrl(): string {
  if (typeof location === "undefined") return "ws://localhost/ws";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

/** The shared WebSocket client instance. */
export const wsClient = new WsClient(buildWsUrl());
