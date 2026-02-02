import type { WebSocket } from "ws";
import type { WsRequest, WsResponse, WsPush, SSEEvent } from "@vladbot/shared";
import { NON_RETRYABLE_TYPES, MAX_RETRY_COUNT, DEFAULT_RETRY_COUNT, API_VERSION } from "@vladbot/shared";
import { getStream } from "../services/streamRegistry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WsHandler = (
  payload: unknown,
  ctx: HandlerContext,
) => Promise<unknown>;

export interface HandlerContext {
  /** Send a push event to this client. */
  push: (sessionId: string, event: SSEEvent) => void;
  /** Register a stream subscriber that will be cleaned up on disconnect. */
  addSubscription: (sessionId: string, callback: (event: SSEEvent) => void) => void;
  /** The raw WebSocket (for rare cases that need it). */
  ws: WebSocket;
  /** API version negotiated during handshake. */
  apiVersion: number;
  /** Broadcast a push event to all clients watching a session (excluding this one). */
  broadcastToSession: (sessionId: string, event: SSEEvent) => void;
  /** Broadcast a push event to all connected clients (excluding this one). */
  broadcastGlobal: (sessionId: string, event: SSEEvent) => void;
}

/** Per-connection state. */
interface ConnectionState {
  retryCount: number;
  apiVersion: number;
  alive: boolean;
  /** Stream subscribers registered by this connection (for cleanup). */
  subscriptions: Map<string, (event: SSEEvent) => void>;
  /** Session IDs this connection is watching. */
  watchedSessions: Set<string>;
}

/** Per-connection entry stored in the connections set. */
interface ConnectionEntry {
  ws: WebSocket;
  state: ConnectionState;
  pingTimer: ReturnType<typeof setInterval>;
  push: (sessionId: string, event: SSEEvent) => void;
  addSubscription: (sessionId: string, callback: (event: SSEEvent) => void) => void;
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

const handlers = new Map<string, WsHandler>();

export function registerHandler(type: string, handler: WsHandler): void {
  handlers.set(type, handler);
}

export function getHandlers(): ReadonlyMap<string, WsHandler> {
  return handlers;
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 30_000;

/** Tracks all active connections for cleanup. */
const connections = new Set<ConnectionEntry>();

export function getConnectionCount(): number {
  return connections.size;
}

export function handleWsConnection(ws: WebSocket): void {
  const state: ConnectionState = {
    retryCount: DEFAULT_RETRY_COUNT,
    apiVersion: 1,
    alive: true,
    subscriptions: new Map(),
    watchedSessions: new Set(),
  };

  // Ping/pong
  const pingTimer = setInterval(() => {
    if (!state.alive) {
      ws.terminate();
      return;
    }
    state.alive = false;
    ws.ping();
  }, PING_INTERVAL_MS);

  ws.on("pong", () => {
    state.alive = true;
  });

  const conn: ConnectionEntry = { ws, state, pingTimer, push: pushEvent, addSubscription };
  connections.add(conn);

  // Helpers
  function send(msg: WsResponse | WsPush): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function respond(seq: number, ok: boolean, data?: unknown, error?: string, status?: number): void {
    const msg: WsResponse = { seq, ok };
    if (data !== undefined) msg.data = data;
    if (error !== undefined) msg.error = error;
    if (status !== undefined) msg.status = status;
    send(msg);
  }

  function pushEvent(sessionId: string, event: SSEEvent): void {
    send({ push: true, sessionId, event });
  }

  function addSubscription(sessionId: string, callback: (event: SSEEvent) => void): void {
    // Remove previous subscription for this session if any
    const prev = state.subscriptions.get(sessionId);
    if (prev) {
      const stream = getStream(sessionId);
      if (stream) stream.subscribers.delete(prev);
    }
    state.subscriptions.set(sessionId, callback);
  }

  function broadcastToSession(sessionId: string, event: SSEEvent): void {
    for (const c of connections) {
      if (c.ws !== ws && c.state.watchedSessions.has(sessionId)) {
        c.push(sessionId, event);
      }
    }
  }

  function broadcastGlobal(sessionId: string, event: SSEEvent): void {
    for (const c of connections) {
      if (c.ws !== ws) {
        c.push(sessionId, event);
      }
    }
  }

  const ctx: HandlerContext = { push: pushEvent, addSubscription, ws, get apiVersion() { return state.apiVersion; }, broadcastToSession, broadcastGlobal };

  // Message handler
  ws.on("message", async (raw) => {
    let msg: WsRequest;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8"));
    } catch {
      respond(-1, false, undefined, "Malformed JSON", 400);
      return;
    }

    const { seq, type, payload } = msg;
    if (typeof seq !== "number" || typeof type !== "string") {
      respond(seq ?? -1, false, undefined, "Invalid message: seq (number) and type (string) required", 400);
      return;
    }

    // Built-in: config.init (preferred handshake — sets version + retries in one message)
    if (type === "config.init") {
      const p = payload as { version?: number; retryCount?: number } | undefined;
      state.apiVersion = typeof p?.version === "number" ? Math.max(1, Math.round(p.version)) : 1;
      if (typeof p?.retryCount === "number") {
        state.retryCount = Math.max(0, Math.min(MAX_RETRY_COUNT, Math.round(p.retryCount)));
      }
      respond(seq, true, { version: API_VERSION });
      return;
    }

    // Built-in: config.retries (legacy handshake — implicitly apiVersion 1)
    if (type === "config.retries") {
      const p = payload as { count?: number } | undefined;
      const count = typeof p?.count === "number" ? Math.max(0, Math.min(MAX_RETRY_COUNT, Math.round(p.count))) : DEFAULT_RETRY_COUNT;
      state.retryCount = count;
      respond(seq, true, {});
      return;
    }

    const handler = handlers.get(type);
    if (!handler) {
      respond(seq, false, undefined, `Unknown message type: ${type}`, 400);
      return;
    }

    const retryable = !NON_RETRYABLE_TYPES.has(type);
    const maxAttempts = retryable ? state.retryCount + 1 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await handler(payload, ctx);
        respond(seq, true, result);
        return;
      } catch (err) {
        lastError = err;
        // Don't retry if this was the last attempt
      }
    }

    // All attempts failed
    const errMsg = lastError instanceof Error ? lastError.message : "Internal error";
    const status = (lastError as { status?: number })?.status ?? 500;
    respond(seq, false, undefined, errMsg, status);
  });

  // Cleanup on close
  ws.on("close", () => {
    clearInterval(pingTimer);
    connections.delete(conn);
    // Remove all stream subscriptions
    for (const [sessionId, callback] of state.subscriptions) {
      const stream = getStream(sessionId);
      if (stream) {
        stream.subscribers.delete(callback);
      }
    }
    state.subscriptions.clear();
  });
}

/** Register a WS connection as watching a session. */
export function watchSession(ws: WebSocket, sessionId: string): void {
  for (const c of connections) {
    if (c.ws === ws) {
      c.state.watchedSessions.add(sessionId);
      return;
    }
  }
}

/** Unregister a WS connection from watching a session. */
export function unwatchSession(ws: WebSocket, sessionId: string): void {
  for (const c of connections) {
    if (c.ws === ws) {
      c.state.watchedSessions.delete(sessionId);
      return;
    }
  }
}

/** Get all connection entries watching a specific session. */
export function getSessionWatchers(sessionId: string): ConnectionEntry[] {
  const watchers: ConnectionEntry[] = [];
  for (const c of connections) {
    if (c.state.watchedSessions.has(sessionId)) {
      watchers.push(c);
    }
  }
  return watchers;
}

/** Broadcast a push event to ALL connected clients (server-initiated, no sender exclusion). */
export function broadcastToAllClients(sessionId: string, event: SSEEvent): void {
  for (const c of connections) {
    c.push(sessionId, event);
  }
}

/** Cleanup all connections (for graceful shutdown / tests). */
export function closeAllConnections(): void {
  for (const { ws, pingTimer } of connections) {
    clearInterval(pingTimer);
    ws.terminate();
  }
  connections.clear();
}
