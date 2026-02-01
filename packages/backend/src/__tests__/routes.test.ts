import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";

// Mock database before any app imports
vi.mock("../services/db.js", () => ({
  default: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

// Mock env
vi.mock("../config/env.js", () => ({
  env: {
    ANTHROPIC_API_KEY: "",
    GOOGLE_GEMINI_API_KEY: "",
    DEEPSEEK_API_KEY: "test-key",
    PORT: 0, // random port
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    MEMORY_MAX_STORAGE_TOKENS: 200000,
    MEMORY_MAX_RETURN_TOKENS: 200000,
    VNC_COORDINATE_BACKEND: "vision",
    SHOWUI_API_URL: "",
  },
}));

// Mock sessionStore to avoid real DB calls
const mockSessionStore = {
  createSession: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getSessionModel: vi.fn().mockResolvedValue("deepseek:deepseek-chat"),
  getMessages: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSession: vi.fn(),
  getSessionAutoApprove: vi.fn(),
  deleteSession: vi.fn(),
  addMessage: vi.fn(),
  updateMessage: vi.fn(),
  updateSessionTokenUsage: vi.fn(),
  atomicApprove: vi.fn(),
};

vi.mock("../services/sessionStore.js", () => mockSessionStore);

// Mock sessionFiles
vi.mock("../services/sessionFiles.js", () => ({
  saveSessionFile: vi.fn(),
  getSessionFilePath: vi.fn(),
  deleteSessionFiles: vi.fn(),
}));

// Mock tokenCounter for memory tool and token estimation
vi.mock("../services/tokenCounter.js", () => ({
  countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  estimateMessageTokens: vi.fn((msg: { content: string; toolCalls?: unknown[]; toolResults?: unknown[] }) => {
    let text = msg.content;
    if (msg.toolCalls) text += JSON.stringify(msg.toolCalls);
    if (msg.toolResults) text += JSON.stringify(msg.toolResults);
    return Math.ceil(text.length / 4);
  }),
}));

// Mock stream registry
vi.mock("../services/streamRegistry.js", () => ({
  createStream: vi.fn().mockReturnValue({
    sessionId: "s1",
    assistantId: "m1",
    content: "",
    model: "gpt-4",
    toolCalls: [],
    hasToolCalls: false,
    done: false,
    subscribers: new Set(),
    generation: 1,
  }),
  getStream: vi.fn().mockReturnValue(undefined),
  pushEvent: vi.fn(),
  removeStream: vi.fn(),
  scheduleRemoval: vi.fn(),
  continueStream: vi.fn().mockReturnValue(null),
}));

// Mock toolLoop
const mockExecuteToolRound = vi.fn().mockResolvedValue(undefined);
const mockDenyToolRound = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/toolLoop.js", () => ({
  executeToolRound: (...args: unknown[]) => mockExecuteToolRound(...args),
  denyToolRound: (...args: unknown[]) => mockDenyToolRound(...args),
  buildHistoryFromDB: vi.fn().mockReturnValue([]),
}));

// Mock settingsStore
const mockGetSetting = vi.fn().mockResolvedValue(null);
const mockPutSettings = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/settingsStore.js", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  putSettings: (...args: unknown[]) => mockPutSettings(...args),
  getAllSettings: vi.fn().mockResolvedValue({}),
  getCachedSettings: vi.fn().mockResolvedValue({}),
}));

// Mock compaction service
const mockCompactSession = vi.fn();
vi.mock("../services/compaction.js", () => ({
  compactSession: (...args: unknown[]) => mockCompactSession(...args),
}));

const app = (await import("../app.js")).default;

let server: Server;
let base: string;

beforeEach(() => {
  vi.clearAllMocks();
});

// Start server on random port for testing
const startServer = (): Promise<{ server: Server; base: string }> =>
  new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => {
      const addr = s.address() as { port: number };
      resolve({ server: s, base: `http://127.0.0.1:${addr.port}/api` });
    });
  });

const started = await startServer();
server = started.server;
base = started.base;

afterAll(() => {
  server?.close();
});

describe("GET /api/health", () => {
  it("returns status ok", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("GET /api/tools", () => {
  it("returns tool definitions array", async () => {
    const res = await fetch(`${base}/tools`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.definitions).toBeInstanceOf(Array);

    const names = body.definitions.map((d: { name: string }) => d.name);
    expect(names).toContain("filesystem");
    expect(names).toContain("run_command");
    expect(names).toContain("vnc");
    expect(names).toContain("memory");
  });
});

describe("GET /api/models", () => {
  it("returns models filtered by configured API keys", async () => {
    const res = await fetch(`${base}/models`);
    expect(res.status).toBe(200);
    const models = await res.json();
    expect(models).toBeInstanceOf(Array);
    // Only deepseek key is set, so only deepseek models should appear
    for (const m of models) {
      expect(m.provider).toBe("deepseek");
    }
  });
});

describe("Session routes", () => {
  describe("GET /api/sessions", () => {
    it("returns sessions array", async () => {
      mockSessionStore.listSessions.mockResolvedValueOnce([
        { id: "s1", title: "Chat", createdAt: "2025-01-01", updatedAt: "2025-01-01" },
      ]);

      const res = await fetch(`${base}/sessions`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("s1");
    });
  });

  describe("POST /api/sessions", () => {
    it("creates a session", async () => {
      mockSessionStore.createSession.mockResolvedValueOnce({
        id: "s2",
        title: "New chat",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      });

      const res = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("s2");
    });
  });

  describe("GET /api/sessions/:id", () => {
    it("returns session with messages", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [],
      });

      const res = await fetch(`${base}/sessions/s1`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("s1");
      expect(body.messages).toEqual([]);
    });

    it("returns session with non-empty messages", async () => {
      const msgs = [
        { id: "m1", role: "user", content: "Hello", timestamp: 1000 },
        { id: "m2", role: "assistant", content: "Hi there", model: "test", timestamp: 1001 },
        { id: "m3", role: "user", content: "How are you?", timestamp: 1002 },
      ];
      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: msgs,
      });

      const res = await fetch(`${base}/sessions/s1`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messages).toHaveLength(3);
      expect(body.messages[0].content).toBe("Hello");
      expect(body.messages[1].content).toBe("Hi there");
      expect(body.messages[2].content).toBe("How are you?");
    });

    it("returns different messages for different sessions", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s1",
        title: "Session A",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [{ id: "m1", role: "user", content: "Session A msg", timestamp: 1000 }],
      });
      const resA = await fetch(`${base}/sessions/s1`);
      const bodyA = await resA.json();

      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s2",
        title: "Session B",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [{ id: "m2", role: "user", content: "Session B msg", timestamp: 2000 }],
      });
      const resB = await fetch(`${base}/sessions/s2`);
      const bodyB = await resB.json();

      expect(bodyA.messages[0].content).toBe("Session A msg");
      expect(bodyB.messages[0].content).toBe("Session B msg");
      expect(mockSessionStore.getSession).toHaveBeenCalledWith("s1");
      expect(mockSessionStore.getSession).toHaveBeenCalledWith("s2");
    });

    it("returns 404 for missing session", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/sessions/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/sessions/:id", () => {
    it("updates session title", async () => {
      mockSessionStore.updateSession.mockResolvedValueOnce({
        id: "s1",
        title: "Updated",
        autoApprove: false,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-02",
      });

      const res = await fetch(`${base}/sessions/s1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Updated" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe("Updated");
    });

    it("updates autoApprove", async () => {
      mockSessionStore.updateSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        autoApprove: true,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-02",
      });

      const res = await fetch(`${base}/sessions/s1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoApprove: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.autoApprove).toBe(true);
    });

    it("returns 400 for empty title", async () => {
      const res = await fetch(`${base}/sessions/s1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "" }),
      });
      expect(res.status).toBe(400);
    });

    it("updates visionModel", async () => {
      mockSessionStore.updateSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        autoApprove: false,
        model: "deepseek:deepseek-chat",
        visionModel: "gemini:gemini-2.0-flash",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-02",
      });

      const res = await fetch(`${base}/sessions/s1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visionModel: "gemini:gemini-2.0-flash" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.visionModel).toBe("gemini:gemini-2.0-flash");
    });

    it("clears visionModel with empty string", async () => {
      mockSessionStore.updateSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        autoApprove: false,
        model: "deepseek:deepseek-chat",
        visionModel: "",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-02",
      });

      const res = await fetch(`${base}/sessions/s1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visionModel: "" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.visionModel).toBe("");
    });

    it("returns 400 when no fields provided", async () => {
      const res = await fetch(`${base}/sessions/s1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing session", async () => {
      mockSessionStore.updateSession.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/sessions/nonexistent`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "X" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/sessions/:id", () => {
    it("deletes session", async () => {
      mockSessionStore.deleteSession.mockResolvedValueOnce(true);

      const res = await fetch(`${base}/sessions/s1`, { method: "DELETE" });
      expect(res.status).toBe(204);
    });

    it("returns 404 for missing session", async () => {
      mockSessionStore.deleteSession.mockResolvedValueOnce(false);

      const res = await fetch(`${base}/sessions/nonexistent`, { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/sessions/:id/messages", () => {
    it("adds a message", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [],
      });
      mockSessionStore.addMessage.mockResolvedValueOnce("m1");

      const res = await fetch(`${base}/sessions/s1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "m1",
          role: "user",
          content: "Hello",
          timestamp: Date.now(),
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("m1");
    });

    it("returns 404 for missing session", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/sessions/nonexistent/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "m1",
          role: "user",
          content: "Hello",
          timestamp: Date.now(),
        }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid body", async () => {
      const res = await fetch(`${base}/sessions/s1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalid: true }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/sessions/:id/messages/:messageId", () => {
    it("updates a message", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [],
      });
      mockSessionStore.updateMessage.mockResolvedValueOnce(undefined);

      const res = await fetch(`${base}/sessions/s1/messages/m1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalStatus: "approved" }),
      });
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing session", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/sessions/nonexistent/messages/m1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalStatus: "approved" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/sessions/:id/compact", () => {
    it("returns compaction result on success", async () => {
      const compactionMsg = {
        id: "cmp-1",
        role: "compaction",
        content: "Summary of conversation",
        timestamp: 999,
      };
      mockCompactSession.mockResolvedValueOnce({
        compactionMessage: compactionMsg,
        summary: "Summary of conversation",
      });

      const res = await fetch(`${base}/sessions/s1/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary).toBe("Summary of conversation");
      expect(body.compactionMessage.role).toBe("compaction");
    });

    it("returns 404 when session model info not found", async () => {
      mockSessionStore.getSessionModel.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/sessions/s1/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 500 when compaction fails", async () => {
      mockCompactSession.mockRejectedValueOnce(new Error("Not enough messages to compact"));

      const res = await fetch(`${base}/sessions/s1/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Not enough messages to compact");
    });
  });
});

describe("POST /api/chat/stream", () => {
  it("accepts sessionId-only request (server resolves model/tools)", async () => {
    mockSessionStore.getSession.mockResolvedValueOnce({
      id: "s1",
      title: "Chat",
      createdAt: "2025-01-01",
      updatedAt: "2025-01-01",
      messages: [{ id: "m1", role: "user", content: "Hello", timestamp: 1000 }],
    });

    const res = await fetch(`${base}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1",
        assistantId: "a1",
      }),
    });
    // Must not be 400 — server resolves model/tools from session
    expect(res.status).toBe(200);
  });

  it("rejects request without sessionId", async () => {
    const res = await fetch(`${base}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("Last active session routes", () => {
  describe("GET /api/sessions/last-active", () => {
    it("returns null when no last active session", async () => {
      mockGetSetting.mockResolvedValueOnce(null);
      const res = await fetch(`${base}/sessions/last-active`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessionId).toBeNull();
    });

    it("returns stored session ID", async () => {
      mockGetSetting.mockResolvedValueOnce("s1");
      const res = await fetch(`${base}/sessions/last-active`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessionId).toBe("s1");
    });
  });

  describe("PUT /api/sessions/last-active", () => {
    it("saves session ID", async () => {
      const res = await fetch(`${base}/sessions/last-active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s1" }),
      });
      expect(res.status).toBe(200);
      expect(mockPutSettings).toHaveBeenCalledWith({ last_active_session_id: "s1" });
    });

    it("returns 400 for missing sessionId", async () => {
      const res = await fetch(`${base}/sessions/last-active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("Approve/Deny endpoints", () => {
  describe("POST /api/sessions/:id/messages/:messageId/approve", () => {
    it("returns 202 for valid approval", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "Let me check",
            timestamp: 1000,
            toolCalls: [{ id: "tc1", name: "test", arguments: {} }],
            approvalStatus: "pending",
          },
        ],
      });
      mockSessionStore.atomicApprove.mockResolvedValueOnce(true);

      const res = await fetch(`${base}/sessions/s1/messages/m1/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("returns 404 for missing session", async () => {
      mockSessionStore.getSessionModel.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/sessions/nonexistent/messages/m1/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing message", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [],
      });

      const res = await fetch(`${base}/sessions/s1/messages/nonexistent/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });

    it("returns 409 for already approved message", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "",
            timestamp: 1000,
            toolCalls: [{ id: "tc1", name: "test", arguments: {} }],
            approvalStatus: "approved",
          },
        ],
      });

      const res = await fetch(`${base}/sessions/s1/messages/m1/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
    });

    it("always creates a fresh stream even if one already exists", async () => {
      const { createStream: mockCreate, getStream: mockGet } = await import("../services/streamRegistry.js");

      // Simulate an existing done stream from the first LLM round
      (mockGet as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        sessionId: "s1",
        assistantId: "old-a1",
        content: "done content",
        model: "deepseek-chat",
        toolCalls: [],
        hasToolCalls: true,
        done: true,
        subscribers: new Set(),
      });

      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "Let me check",
            timestamp: 1000,
            toolCalls: [{ id: "tc1", name: "test", arguments: {} }],
            approvalStatus: "pending",
          },
        ],
      });
      mockSessionStore.atomicApprove.mockResolvedValueOnce(true);

      const res = await fetch(`${base}/sessions/s1/messages/m1/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(202);

      // createStream must be called unconditionally to replace the stale done stream
      expect(mockCreate).toHaveBeenCalledWith("s1", "m1", "deepseek-chat");
    });
  });

  describe("POST /api/sessions/:id/messages/:messageId/deny", () => {
    it("returns 200 for valid denial", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "",
            timestamp: 1000,
            toolCalls: [{ id: "tc1", name: "test", arguments: {} }],
            approvalStatus: "pending",
          },
        ],
      });

      const res = await fetch(`${base}/sessions/s1/messages/m1/deny`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("returns 404 for missing session", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce(null);

      const res = await fetch(`${base}/sessions/nonexistent/messages/m1/deny`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing message", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [],
      });

      const res = await fetch(`${base}/sessions/s1/messages/nonexistent/deny`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("returns 409 for non-pending message", async () => {
      mockSessionStore.getSession.mockResolvedValueOnce({
        id: "s1",
        title: "Chat",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "",
            timestamp: 1000,
            toolCalls: [{ id: "tc1", name: "test", arguments: {} }],
            approvalStatus: "denied",
          },
        ],
      });

      const res = await fetch(`${base}/sessions/s1/messages/m1/deny`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
    });
  });
});

describe("Chat tool routes", () => {
  describe("POST /api/chat/tools/validate", () => {
    it("validates tool calls", async () => {
      const res = await fetch(`${base}/chat/tools/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolCalls: [
            { id: "tc1", name: "filesystem_list_directory", arguments: {} },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.errors).toBeInstanceOf(Array);
    });
  });

  describe("POST /api/chat/tools/execute", () => {
    it("executes tool calls", async () => {
      const res = await fetch(`${base}/chat/tools/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolCalls: [
            { id: "tc1", name: "filesystem_list_directory", arguments: { path: "/tmp" } },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].toolCallId).toBe("tc1");
    });

    it("returns error for unknown tool", async () => {
      const res = await fetch(`${base}/chat/tools/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolCalls: [
            { id: "tc2", name: "nonexistent", arguments: {} },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results[0].isError).toBe(true);
    });

    it("returns 400 for invalid body", async () => {
      const res = await fetch(`${base}/chat/tools/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("Paginated messages", () => {
  describe("GET /api/sessions/:id/messages", () => {
    it("returns paginated messages with hasMore", async () => {
      mockSessionStore.getMessages.mockResolvedValue({
        messages: [
          { id: "m1", role: "user", content: "Hello", timestamp: 1000 },
          { id: "m2", role: "assistant", content: "Hi", timestamp: 1001 },
        ],
        hasMore: true,
      });

      const res = await fetch(`${base}/sessions/s1/messages`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messages).toHaveLength(2);
      expect(body.hasMore).toBe(true);
    });

    it("passes before and limit params", async () => {
      mockSessionStore.getMessages.mockResolvedValue({
        messages: [],
        hasMore: false,
      });

      await fetch(`${base}/sessions/s1/messages?before=5000&limit=10`);
      expect(mockSessionStore.getMessages).toHaveBeenCalledWith("s1", {
        before: 5000,
        limit: 10,
      });
    });

    it("returns empty result for session with no messages", async () => {
      mockSessionStore.getMessages.mockResolvedValue({
        messages: [],
        hasMore: false,
      });

      const res = await fetch(`${base}/sessions/s1/messages`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messages).toEqual([]);
      expect(body.hasMore).toBe(false);
    });

    it("returns 400 for invalid before parameter", async () => {
      const res = await fetch(`${base}/sessions/s1/messages?before=notanumber`);
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid limit parameter", async () => {
      const res = await fetch(`${base}/sessions/s1/messages?limit=0`);
      expect(res.status).toBe(400);
    });

    it("returns 400 for limit exceeding max", async () => {
      const res = await fetch(`${base}/sessions/s1/messages?limit=999`);
      expect(res.status).toBe(400);
    });
  });
});
