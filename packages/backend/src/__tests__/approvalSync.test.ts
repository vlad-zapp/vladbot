import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SSEEvent } from "@vladbot/shared";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that touch handlers.ts
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockAtomicApprove,
  mockAddMessage,
  mockUpdateMessage,
  mockDenyToolRound,
  mockExecuteToolRound,
  mockCreateStream,
  mockGetStream,
  mockPushEvent,
  mockGetSessionWatchers,
  capturedHandlers,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockAtomicApprove: vi.fn(),
  mockAddMessage: vi.fn().mockResolvedValue("new-msg-id"),
  mockUpdateMessage: vi.fn().mockResolvedValue(undefined),
  mockDenyToolRound: vi.fn().mockResolvedValue(undefined),
  mockExecuteToolRound: vi.fn().mockResolvedValue(undefined),
  mockCreateStream: vi.fn(),
  mockGetStream: vi.fn(),
  mockPushEvent: vi.fn(),
  mockGetSessionWatchers: vi.fn().mockReturnValue([]),
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
  getMessages: vi.fn(),
  updateSessionTitle: vi.fn(),
  deleteSession: vi.fn(),
  addMessage: (...args: unknown[]) => mockAddMessage(...args),
  updateMessage: (...args: unknown[]) => mockUpdateMessage(...args),
  atomicApprove: (...args: unknown[]) => mockAtomicApprove(...args),
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
  compactSession: vi.fn(),
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
const MODEL = "test-model";
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
      { sessionId: SESSION_ID, messageId: MESSAGE_ID, model: MODEL, provider: PROVIDER },
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
      { sessionId: SESSION_ID, messageId: MESSAGE_ID, model: MODEL, provider: PROVIDER },
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
        { sessionId: SESSION_ID, messageId: MESSAGE_ID, model: MODEL, provider: PROVIDER },
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
        { sessionId: SESSION_ID, messageId: MESSAGE_ID, model: MODEL, provider: PROVIDER },
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
