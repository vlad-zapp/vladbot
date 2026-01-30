import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SSEEvent } from "@vladbot/shared";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WsListener = (event: { data: string }) => void;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: WsListener | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

// Stub localStorage
const store: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => { store[key] = val; },
  removeItem: (key: string) => { delete store[key]; },
});

vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal("location", { protocol: "http:", host: "localhost:5173" });

// Import after globals are set up
const { WsClient } = await import("../services/wsClient.js");

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
  for (const key of Object.keys(store)) delete store[key];
});

afterEach(() => {
  vi.useRealTimers();
});

function createClient(): { client: InstanceType<typeof WsClient>; ws: MockWebSocket } {
  const client = new WsClient("ws://localhost:3001/ws");
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  return { client, ws };
}

function openClient(): { client: InstanceType<typeof WsClient>; ws: MockWebSocket } {
  const { client, ws } = createClient();
  ws.simulateOpen();
  return { client, ws };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WsClient", () => {
  describe("connection", () => {
    it("connects on construction", () => {
      createClient();
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0].url).toBe("ws://localhost:3001/ws");
    });

    it("sets connected=true on open", () => {
      const { client, ws } = createClient();
      expect(client.connected).toBe(false);
      ws.simulateOpen();
      expect(client.connected).toBe(true);
    });

    it("fires connectionChange on open and close", () => {
      const { client, ws } = createClient();
      const changes: boolean[] = [];
      client.onConnectionChange((c: boolean) => changes.push(c));

      ws.simulateOpen();
      expect(changes).toEqual([true]);

      ws.simulateClose();
      expect(changes).toEqual([true, false]);
    });

    it("reconnects with exponential backoff", () => {
      const { client, ws } = createClient();
      ws.simulateOpen();
      ws.simulateClose();

      // First reconnect at 100ms
      expect(MockWebSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(100);
      expect(MockWebSocket.instances).toHaveLength(2);

      // Fail again
      MockWebSocket.instances[1].simulateClose();

      // Second reconnect at 200ms
      vi.advanceTimersByTime(199);
      expect(MockWebSocket.instances).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(3);

      client.close();
    });

    it("caps backoff at 5s", () => {
      const { client, ws } = createClient();
      ws.simulateOpen();

      // Disconnect many times to ramp up backoff
      for (let i = 0; i < 20; i++) {
        const lastWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        lastWs.simulateClose();
        vi.advanceTimersByTime(5000);
        const newWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        newWs.readyState = MockWebSocket.OPEN;
        newWs.onopen?.();
      }

      // Disconnect again — backoff should still be <= 5s
      const lastWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      const countBefore = MockWebSocket.instances.length;
      lastWs.simulateClose();
      vi.advanceTimersByTime(5000);
      expect(MockWebSocket.instances.length).toBe(countBefore + 1);

      client.close();
    });

    it("resets backoff on successful connection", () => {
      const { client, ws } = createClient();
      ws.simulateOpen();
      ws.simulateClose();

      // Ramp up backoff
      vi.advanceTimersByTime(100);
      MockWebSocket.instances[1].simulateClose();
      vi.advanceTimersByTime(200);
      MockWebSocket.instances[2].simulateClose();
      vi.advanceTimersByTime(400);

      // Successful connect resets backoff
      MockWebSocket.instances[3].simulateOpen();
      MockWebSocket.instances[3].simulateClose();

      // Should reconnect at 100ms again (reset)
      const countBefore = MockWebSocket.instances.length;
      vi.advanceTimersByTime(100);
      expect(MockWebSocket.instances.length).toBe(countBefore + 1);

      client.close();
    });
  });

  describe("handshake", () => {
    it("sends config.init on connect with default retryCount", () => {
      const { ws } = openClient();
      expect(ws.sent).toHaveLength(1);
      const msg = JSON.parse(ws.sent[0]);
      expect(msg.type).toBe("config.init");
      expect(msg.payload.version).toBe(1);
      expect(msg.payload.retryCount).toBe(2);
    });

    it("sends config.init with stored localStorage retryCount", () => {
      store["ws_retry_count"] = "5";
      const { ws } = openClient();
      const msg = JSON.parse(ws.sent[0]);
      expect(msg.payload.retryCount).toBe(5);
    });

    it("clamps stored value to max 10", () => {
      store["ws_retry_count"] = "99";
      const { ws } = openClient();
      const msg = JSON.parse(ws.sent[0]);
      expect(msg.payload.retryCount).toBe(10);
    });
  });

  describe("request-response", () => {
    it("resolves with data on ok:true", async () => {
      const { client, ws } = openClient();
      const promise = client.request("sessions.list", {});

      // Extract seq from sent message
      const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
      ws.simulateMessage({ seq: sent.seq, ok: true, data: [{ id: "s1" }] });

      const result = await promise;
      expect(result).toEqual([{ id: "s1" }]);
    });

    it("rejects on ok:false", async () => {
      const { client, ws } = openClient();
      const promise = client.request("sessions.get", { id: "bad" });

      const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
      ws.simulateMessage({ seq: sent.seq, ok: false, error: "Not found", status: 404 });

      await expect(promise).rejects.toThrow("Not found");
    });

    it("rejects on timeout", async () => {
      const { client } = openClient();
      const promise = client.request("sessions.list", {});

      vi.advanceTimersByTime(30_000);

      await expect(promise).rejects.toThrow("Request timed out");
    });

    it("handles concurrent requests with different seq", async () => {
      const { client, ws } = openClient();
      const p1 = client.request("sessions.list", {});
      const p2 = client.request("models.list", {});

      const sent1 = JSON.parse(ws.sent[ws.sent.length - 2]);
      const sent2 = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(sent1.seq).not.toBe(sent2.seq);

      // Respond out of order
      ws.simulateMessage({ seq: sent2.seq, ok: true, data: ["model1"] });
      ws.simulateMessage({ seq: sent1.seq, ok: true, data: ["session1"] });

      expect(await p1).toEqual(["session1"]);
      expect(await p2).toEqual(["model1"]);
    });

    it("uses monotonically increasing seq", () => {
      const { client, ws } = openClient();
      client.request("a", {}).catch(() => {});
      client.request("b", {}).catch(() => {});
      client.request("c", {}).catch(() => {});

      const seqs = ws.sent.slice(1).map((s) => JSON.parse(s).seq); // skip config.init
      expect(seqs[0]).toBeLessThan(seqs[1]);
      expect(seqs[1]).toBeLessThan(seqs[2]);
    });

    it("waits for connection then sends", async () => {
      const { client, ws } = createClient();
      // Request while not yet connected — should queue
      const promise = client.request("sessions.list", {});

      // Open the connection — queued request should fire
      ws.simulateOpen();

      const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
      ws.simulateMessage({ seq: sent.seq, ok: true, data: ["s1"] });

      const result = await promise;
      expect(result).toEqual(["s1"]);
    });

    it("rejects when intentionally closed", async () => {
      const { client } = createClient();
      client.close();
      await expect(client.request("test", {})).rejects.toThrow("WebSocket not connected");
    });

    it("rejects queued request on timeout", async () => {
      const { client } = createClient();
      // Request while not connected — will wait
      const promise = client.request("test", {});

      // Advance past the 30s timeout
      vi.advanceTimersByTime(30_000);

      await expect(promise).rejects.toThrow("WebSocket not connected");
    });
  });

  describe("push events", () => {
    it("routes push events to correct session listener", () => {
      const { client, ws } = openClient();
      const events1: SSEEvent[] = [];
      const events2: SSEEvent[] = [];

      client.onPush("s1", (e: SSEEvent) => events1.push(e));
      client.onPush("s2", (e: SSEEvent) => events2.push(e));

      ws.simulateMessage({ push: true, sessionId: "s1", event: { type: "token", data: "hello" } });
      ws.simulateMessage({ push: true, sessionId: "s2", event: { type: "token", data: "world" } });

      expect(events1).toHaveLength(1);
      expect(events1[0]).toEqual({ type: "token", data: "hello" });
      expect(events2).toHaveLength(1);
      expect(events2[0]).toEqual({ type: "token", data: "world" });
    });

    it("multiple listeners for same session all receive events", () => {
      const { client, ws } = openClient();
      const a: SSEEvent[] = [];
      const b: SSEEvent[] = [];

      client.onPush("s1", (e: SSEEvent) => a.push(e));
      client.onPush("s1", (e: SSEEvent) => b.push(e));

      ws.simulateMessage({ push: true, sessionId: "s1", event: { type: "token", data: "x" } });

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it("unsubscribe stops delivery", () => {
      const { client, ws } = openClient();
      const events: SSEEvent[] = [];

      const unsub = client.onPush("s1", (e: SSEEvent) => events.push(e));

      ws.simulateMessage({ push: true, sessionId: "s1", event: { type: "token", data: "a" } });
      expect(events).toHaveLength(1);

      unsub();

      ws.simulateMessage({ push: true, sessionId: "s1", event: { type: "token", data: "b" } });
      expect(events).toHaveLength(1); // no new event
    });
  });

  describe("disconnect", () => {
    it("rejects all pending requests on disconnect", async () => {
      const { client, ws } = openClient();
      const p1 = client.request("a", {});
      const p2 = client.request("b", {});

      ws.simulateClose();

      await expect(p1).rejects.toThrow("WebSocket disconnected");
      await expect(p2).rejects.toThrow("WebSocket disconnected");
    });

    it("sets connected to false", () => {
      const { client, ws } = openClient();
      expect(client.connected).toBe(true);
      ws.simulateClose();
      expect(client.connected).toBe(false);
    });
  });

  describe("close", () => {
    it("cancels pending reconnect timer", () => {
      const { client, ws } = openClient();
      ws.simulateClose(); // schedules reconnect
      const countBefore = MockWebSocket.instances.length;
      client.close();
      vi.advanceTimersByTime(10_000);
      expect(MockWebSocket.instances.length).toBe(countBefore);
    });

    it("rejects queued requests waiting for connection", async () => {
      const { client } = createClient();
      const promise = client.request("test", {});
      client.close();
      await expect(promise).rejects.toThrow("WebSocket not connected");
    });
  });

  describe("retry config", () => {
    it("setRetryCount sends config.init to server", () => {
      const { client, ws } = openClient();
      const beforeCount = ws.sent.length;

      client.setRetryCount(5);

      const lastMsg = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(lastMsg.type).toBe("config.init");
      expect(lastMsg.payload.retryCount).toBe(5);
      expect(ws.sent.length).toBe(beforeCount + 1);
    });

    it("persists to localStorage", () => {
      const { client } = openClient();
      client.setRetryCount(7);
      expect(store["ws_retry_count"]).toBe("7");
    });

    it("clamps to 0-10", () => {
      const { client } = openClient();

      client.setRetryCount(-5);
      expect(client.getRetryCount()).toBe(0);

      client.setRetryCount(15);
      expect(client.getRetryCount()).toBe(10);
    });
  });
});
