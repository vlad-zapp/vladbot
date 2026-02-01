import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SSEEvent } from "@vladbot/shared";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that touch handlers.ts
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockGetSessionModelInfo,
  mockAtomicApprove,
  mockAddMessage,
  mockUpdateMessage,
  mockUpdateSession,
  mockDenyToolRound,
  mockExecuteToolRound,
  mockCreateStream,
  mockGetStream,
  mockPushEvent,
  mockGetSessionWatchers,
  mockCompactSession,
  capturedHandlers,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetSessionModelInfo: vi.fn(),
  mockAtomicApprove: vi.fn(),
  mockAddMessage: vi.fn().mockResolvedValue("new-msg-id"),
  mockUpdateMessage: vi.fn().mockResolvedValue(undefined),
  mockUpdateSession: vi.fn(),
  mockDenyToolRound: vi.fn().mockResolvedValue(undefined),
  mockExecuteToolRound: vi.fn().mockResolvedValue(undefined),
  mockCreateStream: vi.fn(),
  mockGetStream: vi.fn(),
  mockPushEvent: vi.fn(),
  mockGetSessionWatchers: vi.fn().mockReturnValue([]),
  mockCompactSession: vi.fn(),
  capturedHandlers: new Map<string, (payload: unknown, ctx: unknown) => Promise<unknown>>(),
}));

vi.mock("../ws/wsServer.js", () => ({
  registerHandler: (type: string, handler: (payload: unknown, ctx: unknown) => Promise<unknown>) => {
    capturedHandlers.set(type, handler);
  },
  getHandlers: () => capturedHandlers,
  watchSession: vi.fn(),
  unwatchSession: vi.fn(),
  getSessionWatchers: (...args: unknown[]) => mockGetSessionWatchers(...args),
}));

vi.mock("../services/sessionStore.js", () => ({
  createSession: vi.fn(),
  listSessions: vi.fn(),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  getSessionModelInfo: (...args: unknown[]) => mockGetSessionModelInfo(...args),
  getMessages: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
  deleteSession: vi.fn(),
  addMessage: (...args: unknown[]) => mockAddMessage(...args),
  updateMessage: (...args: unknown[]) => mockUpdateMessage(...args),
  atomicApprove: (...args: unknown[]) => mockAtomicApprove(...args),
  getSessionAutoApprove: vi.fn().mockResolvedValue(false),
  updateSessionTokenUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/streamRegistry.js", () => ({
  createStream: (...args: unknown[]) => mockCreateStream(...args),
  getStream: (...args: unknown[]) => mockGetStream(...args),
  pushEvent: (...args: unknown[]) => mockPushEvent(...args),
  removeStream: vi.fn(),
  scheduleRemoval: vi.fn(),
  continueStream: vi.fn(),
}));

vi.mock("../services/toolLoop.js", () => ({
  executeToolRound: (...args: unknown[]) => mockExecuteToolRound(...args),
  denyToolRound: (...args: unknown[]) => mockDenyToolRound(...args),
  buildHistoryFromDB: vi.fn().mockReturnValue([]),
}));

vi.mock("../services/tools/index.js", () => ({
  getToolDefinitions: vi.fn().mockReturnValue([]),
  executeToolCalls: vi.fn(),
  validateToolCalls: vi.fn(),
}));

vi.mock("../services/tokenCounter.js", () => ({
  estimateMessageTokens: vi.fn().mockReturnValue(10),
}));

vi.mock("../services/settingsStore.js", () => ({
  getSetting: vi.fn(),
  putSettings: vi.fn(),
}));

vi.mock("../config/runtimeSettings.js", () => ({
  getAllRuntimeSettings: vi.fn().mockResolvedValue({}),
  getRuntimeSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/ai/ProviderFactory.js", () => ({
  getProvider: vi.fn(),
}));

vi.mock("../services/ai/errorClassifier.js", () => ({
  classifyLLMError: vi.fn(),
}));

vi.mock("../services/autoCompact.js", () => ({
  autoCompactIfNeeded: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/sessionFiles.js", () => ({
  saveSessionFile: vi.fn(),
}));

vi.mock("../services/compaction.js", () => ({
  compactSession: (...args: unknown[]) => mockCompactSession(...args),
}));

vi.mock("../services/memoryStore.js", () => ({
  listMemories: vi.fn(),
  getMemory: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  getMemoryStats: vi.fn(),
}));

vi.mock("../config/env.js", () => ({
  env: {},
}));

// Import handlers — triggers all registerHandler calls into capturedHandlers
import "../ws/handlers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(wsId = "client-a") {
  return {
    ws: { id: wsId },
    apiVersion: 1,
    push: vi.fn(),
    addSubscription: vi.fn(),
    broadcastToSession: vi.fn(),
    broadcastGlobal: vi.fn(),
  };
}

function makeWatcher(id: string) {
  return {
    ws: { id },
    state: { watchedSessions: new Set<string>() },
    pingTimer: 0,
    push: vi.fn(),
    addSubscription: vi.fn(),
  };
}

const SESSION_ID = "session-1";
const MESSAGE_ID = "msg-1";
const MODEL = "claude-sonnet-4-20250514";
const PROVIDER = "anthropic";

function baseSession(approvalStatus = "pending") {
  return {
    id: SESSION_ID,
    title: "Test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      {
        id: MESSAGE_ID,
        role: "assistant",
        content: "Let me run that tool",
        model: MODEL,
        timestamp: Date.now(),
        toolCalls: [{ id: "tc-1", name: "test_tool", arguments: {} }],
        approvalStatus,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionWatchers.mockReturnValue([]);
  // Default: session has a known model/provider
  mockGetSessionModelInfo.mockResolvedValue({ model: MODEL, provider: PROVIDER });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("messages.approve — cross-client sync", () => {
  it("subscribes other session watchers to the tool execution stream", async () => {
    const handler = capturedHandlers.get("messages.approve")!;
    expect(handler).toBeDefined();

    const ctx = makeCtx();
    const watcherB = makeWatcher("client-b");
    mockGetSessionWatchers.mockReturnValue([watcherB]);

    mockGetSession.mockResolvedValueOnce(baseSession());
    mockAtomicApprove.mockResolvedValueOnce(true);

    const fakeStream = {
      subscribers: new Set<(event: SSEEvent) => void>(),
      content: "",
      model: MODEL,
      toolCalls: [],
    };
    mockCreateStream.mockReturnValueOnce(fakeStream);

    await handler(
      { sessionId: SESSION_ID, messageId: MESSAGE_ID },
      ctx,
    );

    // Watcher B should have been subscribed to the stream
    expect(watcherB.addSubscription).toHaveBeenCalledWith(SESSION_ID, expect.any(Function));

    // Watcher B should have received a snapshot
    expect(watcherB.push).toHaveBeenCalledWith(SESSION_ID, {
      type: "snapshot",
      data: expect.objectContaining({
        assistantId: MESSAGE_ID,
        model: MODEL,
      }),
    });

    // Stream should have subscribers for both the approving client and the watcher
    expect(fakeStream.subscribers.size).toBeGreaterThanOrEqual(2);
  });

  it("does not subscribe the approving client twice via watchers loop", async () => {
    const handler = capturedHandlers.get("messages.approve")!;

    const sharedWs = { id: "client-a" };
    const ctx = makeCtx();
    (ctx as Record<string, unknown>).ws = sharedWs;

    // The approving client is also watching the session
    const watcherA = makeWatcher("client-a");
    watcherA.ws = sharedWs;
    mockGetSessionWatchers.mockReturnValue([watcherA]);

    mockGetSession.mockResolvedValueOnce(baseSession());
    mockAtomicApprove.mockResolvedValueOnce(true);

    const fakeStream = {
      subscribers: new Set<(event: SSEEvent) => void>(),
      content: "",
      model: MODEL,
      toolCalls: [],
    };
    mockCreateStream.mockReturnValueOnce(fakeStream);

    await handler(
      { sessionId: SESSION_ID, messageId: MESSAGE_ID },
      ctx,
    );

    // Only 1 subscriber (the approving client), not 2
    expect(fakeStream.subscribers.size).toBe(1);
    // Watcher A (same as approving client) should not get a separate snapshot
    expect(watcherA.push).not.toHaveBeenCalled();
  });

  it("works with no other watchers (no crash)", async () => {
    const handler = capturedHandlers.get("messages.approve")!;
    const ctx = makeCtx();

    mockGetSessionWatchers.mockReturnValue([]);
    mockGetSession.mockResolvedValueOnce(baseSession());
    mockAtomicApprove.mockResolvedValueOnce(true);

    const fakeStream = {
      subscribers: new Set<(event: SSEEvent) => void>(),
      content: "",
      model: MODEL,
      toolCalls: [],
    };
    mockCreateStream.mockReturnValueOnce(fakeStream);

    await expect(
      handler(
        { sessionId: SESSION_ID, messageId: MESSAGE_ID },
        ctx,
      ),
    ).resolves.toEqual({});
  });

  it("returns 409 when message was already approved concurrently", async () => {
    const handler = capturedHandlers.get("messages.approve")!;
    const ctx = makeCtx();

    mockGetSession.mockResolvedValueOnce(baseSession());
    mockAtomicApprove.mockResolvedValueOnce(false);

    await expect(
      handler(
        { sessionId: SESSION_ID, messageId: MESSAGE_ID },
        ctx,
      ),
    ).rejects.toThrow("Message was already approved by a concurrent request");
  });
});

describe("messages.deny — cross-client sync", () => {
  it("broadcasts denial to other session watchers", async () => {
    const handler = capturedHandlers.get("messages.deny")!;
    expect(handler).toBeDefined();

    const ctx = makeCtx();
    mockGetSession.mockResolvedValueOnce(baseSession());
    mockDenyToolRound.mockResolvedValueOnce(undefined);

    await handler(
      { sessionId: SESSION_ID, messageId: MESSAGE_ID },
      ctx,
    );

    // Should broadcast the denial status to other watchers
    expect(ctx.broadcastToSession).toHaveBeenCalledWith(
      SESSION_ID,
      {
        type: "approval_changed",
        data: { messageId: MESSAGE_ID, approvalStatus: "denied" },
      },
    );
  });

  it("returns 409 when message is not pending", async () => {
    const handler = capturedHandlers.get("messages.deny")!;
    const ctx = makeCtx();

    mockGetSession.mockResolvedValueOnce(baseSession("approved"));

    await expect(
      handler(
        { sessionId: SESSION_ID, messageId: MESSAGE_ID },
        ctx,
      ),
    ).rejects.toThrow("Message approval status is 'approved', expected 'pending'");
  });
});

// ---------------------------------------------------------------------------
// sessions.switchModel — cross-client sync
// ---------------------------------------------------------------------------

describe("sessions.switchModel — cross-client sync", () => {
  const updatedSession = {
    id: SESSION_ID,
    title: "Test",
    model: MODEL,
    provider: PROVIDER,
    autoApprove: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("pushes session_updated to the sender (not just broadcastGlobal)", async () => {
    const handler = capturedHandlers.get("sessions.switchModel")!;
    expect(handler).toBeDefined();

    const ctx = makeCtx();
    mockUpdateSession.mockResolvedValueOnce(updatedSession);
    // No token usage → no compaction
    mockGetSession.mockResolvedValueOnce({ ...updatedSession, messages: [] });

    await handler(
      { sessionId: SESSION_ID, newModel: MODEL },
      ctx,
    );

    // Sender should receive session_updated via ctx.push
    expect(ctx.push).toHaveBeenCalledWith(
      "__sessions__",
      { type: "session_updated", data: updatedSession },
    );
    // Other clients via broadcastGlobal
    expect(ctx.broadcastGlobal).toHaveBeenCalledWith(
      "__sessions__",
      { type: "session_updated", data: updatedSession },
    );
  });

  it("broadcasts compaction lifecycle events when model switch triggers compaction", async () => {
    const handler = capturedHandlers.get("sessions.switchModel")!;
    const ctx = makeCtx();

    mockUpdateSession.mockResolvedValueOnce(updatedSession);
    // High token usage → triggers compaction (>80% of context)
    mockGetSession.mockResolvedValueOnce({
      ...updatedSession,
      messages: [],
      tokenUsage: { inputTokens: 180000, outputTokens: 1000 },
    });

    const compactionMsg = {
      id: "cmp-1",
      role: "compaction",
      content: "Summary",
      timestamp: Date.now(),
    };
    mockCompactSession.mockResolvedValueOnce({
      compactionMessage: compactionMsg,
      summary: "Summary",
    });

    await handler(
      { sessionId: SESSION_ID, newModel: MODEL },
      ctx,
    );

    // Should broadcast compaction_started to sender and session
    expect(ctx.push).toHaveBeenCalledWith(
      SESSION_ID,
      { type: "compaction_started", data: { sessionId: SESSION_ID } },
    );
    expect(ctx.broadcastToSession).toHaveBeenCalledWith(
      SESSION_ID,
      { type: "compaction_started", data: { sessionId: SESSION_ID } },
    );

    // Should broadcast compaction message to sender and session
    expect(ctx.push).toHaveBeenCalledWith(
      SESSION_ID,
      { type: "compaction", data: compactionMsg },
    );
    expect(ctx.broadcastToSession).toHaveBeenCalledWith(
      SESSION_ID,
      { type: "compaction", data: compactionMsg },
    );
  });
});

// ---------------------------------------------------------------------------
// sessions.compact — cross-client sync
// ---------------------------------------------------------------------------

describe("sessions.compact — cross-client sync", () => {
  it("pushes compaction_started and compaction to sender and session watchers", async () => {
    const handler = capturedHandlers.get("sessions.compact")!;
    expect(handler).toBeDefined();

    const ctx = makeCtx();
    const compactionMsg = {
      id: "cmp-2",
      role: "compaction",
      content: "Compacted summary",
      timestamp: Date.now(),
    };
    mockCompactSession.mockResolvedValueOnce({
      compactionMessage: compactionMsg,
      summary: "Compacted summary",
    });

    await handler({ sessionId: SESSION_ID }, ctx);

    // Should push compaction_started to sender
    expect(ctx.push).toHaveBeenCalledWith(
      SESSION_ID,
      { type: "compaction_started", data: { sessionId: SESSION_ID } },
    );
    // Should broadcast compaction_started to other watchers
    expect(ctx.broadcastToSession).toHaveBeenCalledWith(
      SESSION_ID,
      { type: "compaction_started", data: { sessionId: SESSION_ID } },
    );

    // Wait for the background compaction to complete
    await vi.waitFor(() => {
      // Should push compaction to sender
      expect(ctx.push).toHaveBeenCalledWith(
        SESSION_ID,
        { type: "compaction", data: compactionMsg },
      );
    });

    // Should broadcast compaction to other watchers
    expect(ctx.broadcastToSession).toHaveBeenCalledWith(
      SESSION_ID,
      { type: "compaction", data: compactionMsg },
    );
  });

  it("pushes compaction_error on failure", async () => {
    const handler = capturedHandlers.get("sessions.compact")!;
    const ctx = makeCtx();

    mockCompactSession.mockRejectedValueOnce(new Error("Not enough messages to compact"));

    await handler({ sessionId: SESSION_ID }, ctx);

    // Wait for the background compaction to fail
    await vi.waitFor(() => {
      expect(ctx.push).toHaveBeenCalledWith(
        SESSION_ID,
        {
          type: "compaction_error",
          data: { sessionId: SESSION_ID, error: "Not enough messages to compact" },
        },
      );
    });

    expect(ctx.broadcastToSession).toHaveBeenCalledWith(
      SESSION_ID,
      {
        type: "compaction_error",
        data: { sessionId: SESSION_ID, error: "Not enough messages to compact" },
      },
    );
  });

  it("returns immediately (ACK) before compaction completes", async () => {
    const handler = capturedHandlers.get("sessions.compact")!;
    const ctx = makeCtx();

    // Make compaction hang
    let resolveCompaction!: (v: unknown) => void;
    mockCompactSession.mockReturnValueOnce(
      new Promise((resolve) => { resolveCompaction = resolve; }),
    );

    const result = await handler({ sessionId: SESSION_ID }, ctx);

    // Handler returns immediately
    expect(result).toEqual({});

    // compaction_started was pushed, but compaction hasn't finished
    expect(ctx.push).toHaveBeenCalledWith(
      SESSION_ID,
      { type: "compaction_started", data: { sessionId: SESSION_ID } },
    );
    // No compaction event yet (still running)
    expect(ctx.push).not.toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ type: "compaction" }),
    );

    // Resolve compaction
    resolveCompaction({
      compactionMessage: { id: "cmp-3", role: "compaction", content: "Done", timestamp: Date.now() },
      summary: "Done",
    });

    await vi.waitFor(() => {
      expect(ctx.push).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({ type: "compaction" }),
      );
    });
  });
});
