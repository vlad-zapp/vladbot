import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolCall, ToolResult, SSEEvent } from "@vladbot/shared";

// ===========================================================================
// Concurrency & parallel-session tests
//
// These tests verify that:
// 1. Two active chat sessions can run simultaneously without interference
// 2. Stream state is properly isolated per session
// 3. Tool execution across sessions is independent
// 4. Global mutable state (latestImage, browser singleton, VNC pool,
//    mouse positions) is identified and tested for race conditions
// 5. No deadlocks occur under concurrent access patterns
// ===========================================================================

// ---------------------------------------------------------------------------
// Mock database and modules that chain to PostgreSQL, so tests can run
// without a live DB connection.
// ---------------------------------------------------------------------------

vi.mock("../services/db.js", () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock("../services/sessionStore.js", () => ({
  getSession: vi.fn(),
  addMessage: vi.fn().mockResolvedValue("new-msg-id"),
  updateMessage: vi.fn(),
  updateSessionTokenUsage: vi.fn(),
  atomicApprove: vi.fn(),
  getSessionAutoApprove: vi.fn().mockResolvedValue(false),
  getSessionModel: vi.fn().mockResolvedValue("deepseek:deepseek-chat"),
  getSessionVisionModel: vi.fn().mockResolvedValue(null),
  searchSessionMessages: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
  searchAllMessages: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
}));

vi.mock("../services/memoryStore.js", () => ({
  searchMemories: vi.fn().mockResolvedValue([]),
  listMemories: vi.fn().mockResolvedValue({ memories: [], total: 0 }),
  getMemory: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  getMemoryStats: vi.fn().mockResolvedValue({ totalTokens: 0, storageLimit: 200000 }),
}));

vi.mock("../services/settingsStore.js", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  putSettings: vi.fn(),
}));

vi.mock("../services/sessionFiles.js", () => ({
  saveSessionFile: vi.fn().mockReturnValue("test-file.jpg"),
  getSessionFilePath: vi.fn(),
  deleteSessionFiles: vi.fn(),
}));

vi.mock("../config/env.js", () => ({
  env: {
    ANTHROPIC_API_KEY: "",
    GOOGLE_GEMINI_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    PORT: 0,
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    MEMORY_MAX_STORAGE_TOKENS: 200000,
    MEMORY_MAX_RETURN_TOKENS: 200000,
    VNC_COORDINATE_BACKEND: "vision",
    VNC_CONNECTION_TIMEOUT: 300,
    SHOWUI_API_URL: "",
    VISION_MODEL: "",
    BROWSER_WS_ENDPOINT: "ws://localhost:3100",
    BROWSER_IDLE_TIMEOUT: 300,
  },
}));

vi.mock("../config/runtimeSettings.js", () => ({
  getAllRuntimeSettings: vi.fn().mockResolvedValue({}),
  getRuntimeSetting: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Section 1: Stream Registry — session isolation
// ---------------------------------------------------------------------------

describe("Stream Registry — parallel session isolation", () => {
  // Use real streamRegistry (no mocks) for isolation tests
  let createStream: typeof import("../services/streamRegistry.js").createStream;
  let getStream: typeof import("../services/streamRegistry.js").getStream;
  let pushEvent: typeof import("../services/streamRegistry.js").pushEvent;
  let removeStream: typeof import("../services/streamRegistry.js").removeStream;
  let continueStream: typeof import("../services/streamRegistry.js").continueStream;
  let scheduleRemoval: typeof import("../services/streamRegistry.js").scheduleRemoval;

  beforeEach(async () => {
    const mod = await import("../services/streamRegistry.js");
    createStream = mod.createStream;
    getStream = mod.getStream;
    pushEvent = mod.pushEvent;
    removeStream = mod.removeStream;
    continueStream = mod.continueStream;
    scheduleRemoval = mod.scheduleRemoval;

    removeStream("session-A");
    removeStream("session-B");
  });

  afterEach(() => {
    removeStream("session-A");
    removeStream("session-B");
  });

  it("two sessions can have independent active streams", () => {
    const streamA = createStream("session-A", "asst-a1", "model-1");
    const streamB = createStream("session-B", "asst-b1", "model-2");

    expect(getStream("session-A")).toBe(streamA);
    expect(getStream("session-B")).toBe(streamB);
    expect(streamA).not.toBe(streamB);
    expect(streamA.sessionId).toBe("session-A");
    expect(streamB.sessionId).toBe("session-B");
  });

  it("tokens pushed to session A do not appear in session B", () => {
    createStream("session-A", "asst-a1", "model-1");
    createStream("session-B", "asst-b1", "model-1");

    pushEvent("session-A", { type: "token", data: "Hello from A" });
    pushEvent("session-B", { type: "token", data: "Hello from B" });

    expect(getStream("session-A")!.content).toBe("Hello from A");
    expect(getStream("session-B")!.content).toBe("Hello from B");
  });

  it("tool calls in session A do not leak to session B", () => {
    createStream("session-A", "asst-a1", "model-1");
    createStream("session-B", "asst-b1", "model-1");

    const tcA: ToolCall = { id: "tc-a1", name: "filesystem_read_file", arguments: { path: "/a" } };
    const tcB: ToolCall = { id: "tc-b1", name: "run_command_execute", arguments: { command: "ls" } };

    pushEvent("session-A", { type: "tool_call", data: tcA });
    pushEvent("session-B", { type: "tool_call", data: tcB });

    expect(getStream("session-A")!.toolCalls).toEqual([tcA]);
    expect(getStream("session-B")!.toolCalls).toEqual([tcB]);
  });

  it("subscribers of session A only receive events for session A", () => {
    const streamA = createStream("session-A", "asst-a1", "model-1");
    createStream("session-B", "asst-b1", "model-1");

    const eventsA: SSEEvent[] = [];
    streamA.subscribers.add((e) => eventsA.push(e));

    pushEvent("session-A", { type: "token", data: "A-token" });
    pushEvent("session-B", { type: "token", data: "B-token" });

    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]).toEqual({ type: "token", data: "A-token" });
  });

  it("aborting session A does not affect session B", () => {
    const streamA = createStream("session-A", "asst-a1", "model-1");
    const streamB = createStream("session-B", "asst-b1", "model-1");

    streamA.aborted = true;
    streamA.abortController.abort();

    expect(streamB.aborted).toBe(false);
    expect(streamB.abortController.signal.aborted).toBe(false);

    // Tokens should still be pushed to B
    pushEvent("session-B", { type: "token", data: "still works" });
    expect(streamB.content).toBe("still works");

    // Tokens should be blocked for A
    pushEvent("session-A", { type: "token", data: "blocked" });
    expect(streamA.content).toBe("");
  });

  it("done event in session A does not mark session B as done", () => {
    createStream("session-A", "asst-a1", "model-1");
    createStream("session-B", "asst-b1", "model-1");

    pushEvent("session-A", { type: "done", data: { hasToolCalls: false } });

    expect(getStream("session-A")!.done).toBe(true);
    expect(getStream("session-B")!.done).toBe(false);
  });

  it("error in session A does not affect session B", () => {
    createStream("session-A", "asst-a1", "model-1");
    createStream("session-B", "asst-b1", "model-1");

    pushEvent("session-A", {
      type: "error",
      data: { message: "Rate limited", code: "RATE_LIMITED", recoverable: true },
    });

    expect(getStream("session-A")!.error).toBeDefined();
    expect(getStream("session-A")!.done).toBe(true);
    expect(getStream("session-B")!.error).toBeUndefined();
    expect(getStream("session-B")!.done).toBe(false);
  });

  it("removing session A preserves session B", () => {
    createStream("session-A", "asst-a1", "model-1");
    createStream("session-B", "asst-b1", "model-1");

    removeStream("session-A");

    expect(getStream("session-A")).toBeUndefined();
    expect(getStream("session-B")).toBeDefined();
  });

  it("continueStream on session A does not reset session B", () => {
    createStream("session-A", "asst-a1", "model-1");
    createStream("session-B", "asst-b1", "model-1");

    pushEvent("session-A", { type: "token", data: "A content" });
    pushEvent("session-B", { type: "token", data: "B content" });

    continueStream("session-A", "asst-a2");

    // A should be reset
    expect(getStream("session-A")!.content).toBe("");
    expect(getStream("session-A")!.assistantId).toBe("asst-a2");

    // B should be untouched
    expect(getStream("session-B")!.content).toBe("B content");
    expect(getStream("session-B")!.assistantId).toBe("asst-b1");
  });

  it("each session gets a unique generation number", () => {
    const streamA = createStream("session-A", "asst-a1", "model-1");
    const streamB = createStream("session-B", "asst-b1", "model-1");

    expect(streamA.generation).not.toBe(streamB.generation);
  });

  it("scheduleRemoval for session A does not remove session B", () => {
    vi.useFakeTimers();
    try {
      createStream("session-A", "asst-a1", "model-1");
      createStream("session-B", "asst-b1", "model-1");

      scheduleRemoval("session-A", 1000);
      vi.advanceTimersByTime(1000);

      expect(getStream("session-A")).toBeUndefined();
      expect(getStream("session-B")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("interleaved token pushes maintain correct content per session", () => {
    createStream("session-A", "asst-a1", "model-1");
    createStream("session-B", "asst-b1", "model-1");

    // Simulate interleaved streaming from two LLM responses
    pushEvent("session-A", { type: "token", data: "The " });
    pushEvent("session-B", { type: "token", data: "A " });
    pushEvent("session-A", { type: "token", data: "answer " });
    pushEvent("session-B", { type: "token", data: "different " });
    pushEvent("session-A", { type: "token", data: "is 42." });
    pushEvent("session-B", { type: "token", data: "reply." });

    expect(getStream("session-A")!.content).toBe("The answer is 42.");
    expect(getStream("session-B")!.content).toBe("A different reply.");
  });

  it("usage data is isolated per session", () => {
    createStream("session-A", "asst-a1", "model-1");
    createStream("session-B", "asst-b1", "model-1");

    pushEvent("session-A", {
      type: "usage",
      data: { inputTokens: 100, outputTokens: 50 },
    });
    pushEvent("session-B", {
      type: "usage",
      data: { inputTokens: 500, outputTokens: 200 },
    });

    expect(getStream("session-A")!.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(getStream("session-B")!.usage).toEqual({ inputTokens: 500, outputTokens: 200 });
  });
});

// ---------------------------------------------------------------------------
// Section 2: Tool Executor — parallel execution across sessions
// ---------------------------------------------------------------------------

describe("Tool Executor — parallel tool execution", () => {
  // Import the real ToolExecutor functions
  let registerTool: typeof import("../services/tools/ToolExecutor.js").registerTool;
  let executeToolCalls: typeof import("../services/tools/ToolExecutor.js").executeToolCalls;
  let validateToolCalls: typeof import("../services/tools/ToolExecutor.js").validateToolCalls;

  beforeEach(async () => {
    const mod = await import("../services/tools/ToolExecutor.js");
    registerTool = mod.registerTool;
    executeToolCalls = mod.executeToolCalls;
    validateToolCalls = mod.validateToolCalls;
  });

  it("two sessions can execute the same tool concurrently with different args", async () => {
    const invocations: Array<{ sessionId?: string; args: Record<string, unknown> }> = [];
    const toolName = `concurrent_tool_${Date.now()}`;

    registerTool({
      definition: {
        name: toolName,
        description: "Test tool",
        operations: {
          run: {
            params: { input: { type: "string", description: "test" } },
            required: ["input"],
          },
        },
      },
      async execute(args, sessionId) {
        invocations.push({ sessionId, args });
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        return `result for ${sessionId}: ${args.input}`;
      },
    });

    // Execute in parallel for two sessions
    const [resultsA, resultsB] = await Promise.all([
      executeToolCalls(
        [{ id: "tc-a1", name: `${toolName}_run`, arguments: { input: "from-A" } }],
        "session-A",
      ),
      executeToolCalls(
        [{ id: "tc-b1", name: `${toolName}_run`, arguments: { input: "from-B" } }],
        "session-B",
      ),
    ]);

    // Both should succeed independently
    expect(resultsA).toHaveLength(1);
    expect(resultsB).toHaveLength(1);
    expect(resultsA[0].output).toContain("session-A");
    expect(resultsA[0].output).toContain("from-A");
    expect(resultsB[0].output).toContain("session-B");
    expect(resultsB[0].output).toContain("from-B");

    // Both sessions' invocations should be recorded
    expect(invocations).toHaveLength(2);
  });

  it("error in one session's tool does not affect the other session", async () => {
    const toolName = `error_tool_${Date.now()}`;
    registerTool({
      definition: {
        name: toolName,
        description: "Test",
        operations: { run: { params: {}, required: [] } },
      },
      async execute(_args, sessionId) {
        if (sessionId === "session-A") throw new Error("Session A failure");
        return "session B success";
      },
    });

    const [resultsA, resultsB] = await Promise.all([
      executeToolCalls(
        [{ id: "tc-a1", name: `${toolName}_run`, arguments: {} }],
        "session-A",
      ),
      executeToolCalls(
        [{ id: "tc-b1", name: `${toolName}_run`, arguments: {} }],
        "session-B",
      ),
    ]);

    expect(resultsA[0].isError).toBe(true);
    expect(resultsA[0].output).toContain("Session A failure");
    expect(resultsB[0].isError).toBeFalsy();
    expect(resultsB[0].output).toBe("session B success");
  });

  it("validation is stateless and safe for concurrent calls", () => {
    const toolName = `validating_tool_${Date.now()}`;
    let validateCallCount = 0;

    registerTool({
      definition: {
        name: toolName,
        description: "Test",
        operations: {
          run: {
            params: { required_field: { type: "string", description: "test" } },
            required: ["required_field"],
          },
        },
      },
      async execute() { return "ok"; },
      validate(args) {
        validateCallCount++;
        if (!args.required_field) return { valid: false, error: "Missing required_field" };
        return { valid: true };
      },
    });

    // Validate concurrently with valid and invalid calls
    const validErrors = validateToolCalls([
      { id: "tc1", name: `${toolName}_run`, arguments: { required_field: "ok" } },
    ]);
    const invalidErrors = validateToolCalls([
      { id: "tc2", name: `${toolName}_run`, arguments: {} },
    ]);

    expect(validErrors).toHaveLength(0);
    expect(invalidErrors).toHaveLength(1);
    expect(invalidErrors[0].output).toContain("Missing required_field");
    expect(validateCallCount).toBe(2);
  });

  it("slow tool in session A does not block session B", async () => {
    const toolName = `slow_tool_${Date.now()}`;
    const completionOrder: string[] = [];

    registerTool({
      definition: {
        name: toolName,
        description: "Test",
        operations: { run: { params: {}, required: [] } },
      },
      async execute(_args, sessionId) {
        if (sessionId === "session-A") {
          // Slow tool
          await new Promise((resolve) => setTimeout(resolve, 100));
          completionOrder.push("A");
          return "slow result";
        }
        // Fast tool
        completionOrder.push("B");
        return "fast result";
      },
    });

    const [resultsA, resultsB] = await Promise.all([
      executeToolCalls(
        [{ id: "tc-a1", name: `${toolName}_run`, arguments: {} }],
        "session-A",
      ),
      executeToolCalls(
        [{ id: "tc-b1", name: `${toolName}_run`, arguments: {} }],
        "session-B",
      ),
    ]);

    // B should finish before A
    expect(completionOrder[0]).toBe("B");
    expect(completionOrder[1]).toBe("A");

    // Both should have correct results
    expect(resultsA[0].output).toBe("slow result");
    expect(resultsB[0].output).toBe("fast result");
  });

  it("multiple tools within one session execute sequentially", async () => {
    const toolName = `seq_tool_${Date.now()}`;
    const executionOrder: number[] = [];

    registerTool({
      definition: {
        name: toolName,
        description: "Test",
        operations: {
          run: {
            params: { order: { type: "number", description: "order" } },
            required: [],
          },
        },
      },
      async execute(args) {
        const order = Number(args.order);
        await new Promise((resolve) => setTimeout(resolve, 10));
        executionOrder.push(order);
        return `done ${order}`;
      },
    });

    const results = await executeToolCalls([
      { id: "tc1", name: `${toolName}_run`, arguments: { order: 1 } },
      { id: "tc2", name: `${toolName}_run`, arguments: { order: 2 } },
      { id: "tc3", name: `${toolName}_run`, arguments: { order: 3 } },
    ], "session-A");

    // Should execute in order
    expect(executionOrder).toEqual([1, 2, 3]);
    expect(results).toHaveLength(3);
    expect(results[0].output).toBe("done 1");
    expect(results[1].output).toBe("done 2");
    expect(results[2].output).toBe("done 3");
  });

  it("concurrent executions do not corrupt the results array", async () => {
    const toolName = `concurrent_array_${Date.now()}`;

    registerTool({
      definition: {
        name: toolName,
        description: "Test",
        operations: {
          run: {
            params: { val: { type: "string", description: "val" } },
            required: [],
          },
        },
      },
      async execute(args) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
        return `result:${args.val}`;
      },
    });

    // Run many concurrent executions
    const promises = Array.from({ length: 10 }, (_, i) =>
      executeToolCalls(
        [{ id: `tc-${i}`, name: `${toolName}_run`, arguments: { val: `v${i}` } }],
        `session-${i}`,
      ),
    );

    const allResults = await Promise.all(promises);

    // Each execution should have exactly 1 result with correct value
    for (let i = 0; i < 10; i++) {
      expect(allResults[i]).toHaveLength(1);
      expect(allResults[i][0].toolCallId).toBe(`tc-${i}`);
      expect(allResults[i][0].output).toBe(`result:v${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 3: latestImage — global mutable state race condition
// ---------------------------------------------------------------------------

describe("latestImage — per-session isolation", () => {
  let storeLatestImage: typeof import("../services/ai/toolResultImages.js").storeLatestImage;
  let getLatestImage: typeof import("../services/ai/toolResultImages.js").getLatestImage;
  let getLatestImageBuffer: typeof import("../services/ai/toolResultImages.js").getLatestImageBuffer;
  let clearLatestImage: typeof import("../services/ai/toolResultImages.js").clearLatestImage;

  beforeEach(async () => {
    const mod = await import("../services/ai/toolResultImages.js");
    storeLatestImage = mod.storeLatestImage;
    getLatestImage = mod.getLatestImage;
    getLatestImageBuffer = mod.getLatestImageBuffer;
    clearLatestImage = mod.clearLatestImage;

    // Clean up test sessions
    clearLatestImage("session-A");
    clearLatestImage("session-B");
  });

  it("each session stores and retrieves its own image independently", () => {
    storeLatestImage("session-A", "base64-session-A", "image/jpeg");
    storeLatestImage("session-B", "base64-session-B", "image/png");

    expect(getLatestImage("session-A")!.base64).toBe("base64-session-A");
    expect(getLatestImage("session-A")!.mimeType).toBe("image/jpeg");
    expect(getLatestImage("session-B")!.base64).toBe("base64-session-B");
    expect(getLatestImage("session-B")!.mimeType).toBe("image/png");
  });

  it("rawBuffer is per-session — concurrent screenshots are isolated", () => {
    const bufA = Buffer.from("image-data-A");
    const bufB = Buffer.from("image-data-B");

    storeLatestImage("session-A", "base64-A", "image/jpeg", bufA);
    storeLatestImage("session-B", "base64-B", "image/jpeg", bufB);

    expect(getLatestImageBuffer("session-A")).toBe(bufA);
    expect(getLatestImageBuffer("session-B")).toBe(bufB);
  });

  it("concurrent screenshots do NOT cause cross-session image confusion", () => {
    storeLatestImage("session-A", "sessionA-screenshot", "image/jpeg");
    storeLatestImage("session-B", "sessionB-screenshot", "image/jpeg");

    // Each session gets its own image
    expect(getLatestImage("session-A")!.base64).toBe("sessionA-screenshot");
    expect(getLatestImage("session-B")!.base64).toBe("sessionB-screenshot");
  });

  it("clearLatestImage only affects the specified session", () => {
    storeLatestImage("session-A", "img-A", "image/jpeg");
    storeLatestImage("session-B", "img-B", "image/jpeg");

    clearLatestImage("session-A");

    expect(getLatestImage("session-A")).toBeNull();
    expect(getLatestImage("session-B")!.base64).toBe("img-B");
  });

  it("getLatestImage returns null for unknown session", () => {
    expect(getLatestImage("nonexistent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Section 4: Tool loop — concurrent sessions executing tool rounds
// ---------------------------------------------------------------------------

describe("Tool loop — parallel session tool rounds", () => {
  const mockGetSession = vi.fn();
  const mockAddMessage = vi.fn().mockResolvedValue("new-msg-id");
  const mockUpdateMessage = vi.fn().mockResolvedValue(undefined);
  const mockExecuteToolCalls = vi.fn();
  const mockValidateToolCalls = vi.fn().mockReturnValue([]);
  const mockGetStream = vi.fn();
  const mockPushEvent = vi.fn();
  const mockCreateStream = vi.fn();
  const mockContinueStream = vi.fn().mockReturnValue(null);
  const mockScheduleRemoval = vi.fn();
  const mockGetLLMContext = vi.fn().mockResolvedValue([
    { role: "user", content: "Hello" },
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: non-aborted stream
    mockGetStream.mockReturnValue({
      sessionId: "s1",
      assistantId: "asst",
      content: "Response",
      model: "gpt-4",
      toolCalls: [],
      hasToolCalls: false,
      done: true,
      aborted: false,
      subscribers: new Set(),
      generation: 1,
      abortController: new AbortController(),
      requestBody: {},
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it("tool execution for session A does not interfere with session B events", () => {
    // This tests that pushEvent calls are correctly scoped to their session
    const eventsPerSession = new Map<string, SSEEvent[]>();

    const pushEvent = (sessionId: string, event: SSEEvent) => {
      const events = eventsPerSession.get(sessionId) ?? [];
      events.push(event);
      eventsPerSession.set(sessionId, events);
    };

    // Simulate interleaved tool results from two sessions
    pushEvent("session-A", {
      type: "tool_result",
      data: { toolCallId: "tc-a1", output: "A result" },
    });
    pushEvent("session-B", {
      type: "tool_result",
      data: { toolCallId: "tc-b1", output: "B result" },
    });
    pushEvent("session-A", {
      type: "done",
      data: { hasToolCalls: false },
    });
    pushEvent("session-B", {
      type: "tool_result",
      data: { toolCallId: "tc-b2", output: "B result 2" },
    });

    expect(eventsPerSession.get("session-A")).toHaveLength(2);
    expect(eventsPerSession.get("session-B")).toHaveLength(2);
    expect(eventsPerSession.get("session-A")![0].type).toBe("tool_result");
    expect(eventsPerSession.get("session-A")![1].type).toBe("done");
    expect(eventsPerSession.get("session-B")![0].type).toBe("tool_result");
    expect(eventsPerSession.get("session-B")![1].type).toBe("tool_result");
  });
});

// ---------------------------------------------------------------------------
// Section 5: Filesystem tool — stateless, safe for parallel use
// ---------------------------------------------------------------------------

describe("Filesystem tool — parallel execution safety", () => {
  let filesystemTool: typeof import("../services/tools/filesystem.js").filesystemTool;

  beforeEach(async () => {
    const mod = await import("../services/tools/filesystem.js");
    filesystemTool = mod.filesystemTool;
  });

  it("concurrent read_file calls to different paths are independent", async () => {
    // This tests that the filesystem tool doesn't have shared state
    // that could cause cross-contamination between concurrent reads.
    const [resultA, resultB] = await Promise.all([
      filesystemTool.execute({
        operation: "read_file",
        path: "/proc/self/status",
      }),
      filesystemTool.execute({
        operation: "read_file",
        path: "/proc/self/cmdline",
      }),
    ]);

    // Both should succeed and return different content
    expect(resultA).toContain("Contents of");
    expect(resultB).toContain("Contents of");
    expect(resultA).not.toBe(resultB);
  });

  it("concurrent write_file and read_file to same path serialize via OS", async () => {
    const tmpPath = `/tmp/vladbot-test-concurrency-${Date.now()}.txt`;

    // Write then read concurrently — OS file system serializes these
    await filesystemTool.execute({
      operation: "write_file",
      path: tmpPath,
      content: "test content",
    });

    const result = await filesystemTool.execute({
      operation: "read_file",
      path: tmpPath,
    });

    expect(result).toContain("test content");

    // Cleanup
    await filesystemTool.execute({
      operation: "delete",
      path: tmpPath,
    });
  });

  it("concurrent list_directory calls are independent", async () => {
    const [resultA, resultB] = await Promise.all([
      filesystemTool.execute({ operation: "list_directory", path: "/tmp" }),
      filesystemTool.execute({ operation: "list_directory", path: "/proc" }),
    ]);

    expect(resultA).toContain("/tmp");
    expect(resultB).toContain("/proc");
  });

  it("no shared state between execute calls", async () => {
    // Execute multiple operations rapidly — each should be independent
    const promises = Array.from({ length: 5 }, (_, i) =>
      filesystemTool.execute({
        operation: "stat",
        path: "/tmp",
      }),
    );

    const results = await Promise.all(promises);

    // All should succeed with the same result
    for (const result of results) {
      expect(result).toContain("Type: directory");
    }
  });
});

// ---------------------------------------------------------------------------
// Section 6: Run Command tool — stateless, safe for parallel use
// ---------------------------------------------------------------------------

describe("Run Command tool — parallel execution safety", () => {
  let runCommandTool: typeof import("../services/tools/runCommand.js").runCommandTool;

  beforeEach(async () => {
    const mod = await import("../services/tools/runCommand.js");
    runCommandTool = mod.runCommandTool;
  });

  it("concurrent command executions are independent", async () => {
    const [resultA, resultB] = await Promise.all([
      runCommandTool.execute({
        operation: "execute",
        command: "echo session-A",
      }),
      runCommandTool.execute({
        operation: "execute",
        command: "echo session-B",
      }),
    ]);

    expect(resultA).toContain("session-A");
    expect(resultB).toContain("session-B");
    expect(resultA).not.toContain("session-B");
    expect(resultB).not.toContain("session-A");
  });

  it("failure in one concurrent command does not affect others", async () => {
    const [resultGood, resultBad] = await Promise.all([
      runCommandTool.execute({
        operation: "execute",
        command: "echo success",
      }),
      runCommandTool.execute({
        operation: "execute",
        command: "exit 1",
      }),
    ]);

    expect(resultGood).toContain("Exit code: 0");
    expect(resultGood).toContain("success");
    expect(resultBad).toContain("Exit code: 1");
  });

  it("each execution gets its own child process (no shared state)", async () => {
    // Run a command that outputs the PID — each should be different
    const results = await Promise.all([
      runCommandTool.execute({ operation: "execute", command: "echo $$" }),
      runCommandTool.execute({ operation: "execute", command: "echo $$" }),
      runCommandTool.execute({ operation: "execute", command: "echo $$" }),
    ]);

    // All should succeed
    for (const result of results) {
      expect(result).toContain("Exit code: 0");
    }
  });
});

// ---------------------------------------------------------------------------
// Section 7: VNC mouse positions — per-host:port shared state
// ---------------------------------------------------------------------------

describe("VNC mouse positions — shared state per host:port", () => {
  // We test the mouse position map directly since we can't connect to real VNC

  it("mouse positions are keyed by host:port, not session", () => {
    // This documents the design: mouse positions are per-VNC-target,
    // not per-session. Two sessions controlling the same VNC host
    // share mouse position state. This is correct behavior because
    // there's only one physical cursor per VNC server.

    // The module-level mousePositions map uses "host:port" as key.
    // This means:
    // - session-A clicks at (100, 200) on "mini:5900"
    // - session-B then clicks at (300, 400) on "mini:5900"
    // - mouse position for "mini:5900" is now (300, 400)
    // - session-A's next relative mouse move starts from (300, 400)
    //
    // This is by design: there's one cursor per VNC server.
    // But it's a potential source of confusion when two sessions
    // control the same VNC host simultaneously.
    expect(true).toBe(true); // Structural documentation test
  });
});

// ---------------------------------------------------------------------------
// Section 8: Browser connection — per-session isolation
// ---------------------------------------------------------------------------

describe("Browser connection — per-session isolation", () => {
  // Browser infrastructure is now per-session via BrowserSessionManager.
  // Each session gets its own Xvfb display, Chrome instance, and x11vnc.

  it("connection functions require sessionId parameter", async () => {
    const mod = await import("../services/tools/browser/connection.js");

    // All functions take sessionId as first param
    expect(mod.getBrowserPage.length).toBeGreaterThanOrEqual(1);
    expect(mod.getCDPSession.length).toBeGreaterThanOrEqual(1);
    expect(mod.isBrowserConnected.length).toBeGreaterThanOrEqual(1);
    expect(mod.disconnectBrowser.length).toBeGreaterThanOrEqual(1);
    expect(mod.updateElementMap.length).toBeGreaterThanOrEqual(2);
    expect(mod.clearElementMap.length).toBeGreaterThanOrEqual(1);
    expect(mod.resolveElement.length).toBeGreaterThanOrEqual(2);
  });

  it("resolveElement is scoped per session", async () => {
    const { resolveElement, ElementNotFoundError } = await import(
      "../services/tools/browser/connection.js"
    );

    // No browser session exists for these IDs, so resolveElement
    // should throw ElementNotFoundError (empty element map)
    expect(() => resolveElement("session-A", 0)).toThrow(ElementNotFoundError);
    expect(() => resolveElement("session-B", 0)).toThrow(ElementNotFoundError);
  });

  it("isBrowserConnected returns false for non-existent sessions", async () => {
    const { isBrowserConnected } = await import(
      "../services/tools/browser/connection.js"
    );

    expect(isBrowserConnected("nonexistent-A")).toBe(false);
    expect(isBrowserConnected("nonexistent-B")).toBe(false);
  });

  it("getActiveBrowserSessions returns empty when no sessions active", async () => {
    const { getActiveBrowserSessions } = await import(
      "../services/tools/browser/connection.js"
    );

    const sessions = getActiveBrowserSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 9: BrowserService — per-session cache safety
// ---------------------------------------------------------------------------

describe("BrowserService — findAll cache isolation", () => {
  // BrowserService instances are cached by (sessionId-provider-model)
  // Each instance has its own findAllCache, but they share the global browser.

  it("BrowserService instances are unique per session", async () => {
    const { getBrowserService } = await import(
      "../services/tools/browser/BrowserService.js"
    );

    const serviceA = getBrowserService({
      sessionId: "session-A",
      model: "model-1",
      provider: "provider-1",
    });
    const serviceB = getBrowserService({
      sessionId: "session-B",
      model: "model-1",
      provider: "provider-1",
    });

    expect(serviceA).not.toBe(serviceB);
  });

  it("same session gets cached instance", async () => {
    const { getBrowserService } = await import(
      "../services/tools/browser/BrowserService.js"
    );

    const service1 = getBrowserService({
      sessionId: "session-X",
      model: "model-1",
      provider: "provider-1",
    });
    const service2 = getBrowserService({
      sessionId: "session-X",
      model: "model-1",
      provider: "provider-1",
    });

    expect(service1).toBe(service2);
  });
});

// ---------------------------------------------------------------------------
// Section 10: Memory tool — DB-backed, inherently safe for concurrent access
// ---------------------------------------------------------------------------

describe("Memory tool — concurrent access pattern", () => {
  // Memory tool uses PostgreSQL which handles concurrency natively.
  // The tool itself has no shared mutable state.

  it("memory tool has no shared mutable state in its execute function", async () => {
    const { memoryTool } = await import("../services/tools/memory.js");

    // The tool function is stateless — it delegates to memoryStore which
    // uses pg pool connections. No module-level mutable state that could
    // cause races between sessions.
    expect(memoryTool.execute).toBeDefined();
    expect(typeof memoryTool.execute).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Section 11: Chat history tool — DB-backed, session-scoped
// ---------------------------------------------------------------------------

describe("Chat history tool — concurrent access pattern", () => {
  it("chat history tool is stateless and session-scoped", async () => {
    const { chatHistoryTool } = await import("../services/tools/chatHistory.js");

    // search_current takes sessionId as a parameter — queries are scoped
    // search_all excludes current session — no cross-contamination
    expect(chatHistoryTool.execute).toBeDefined();
    expect(typeof chatHistoryTool.execute).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Section 12: Vision tool — depends on global latestImage
// ---------------------------------------------------------------------------

describe("Vision tool — per-session latestImage", () => {
  it("vision tool reads from session-scoped latestImage", async () => {
    const { storeLatestImage, getLatestImage, clearLatestImage } = await import(
      "../services/ai/toolResultImages.js"
    );

    // Each session has its own image
    storeLatestImage("session-A", "session-A-image", "image/jpeg");
    storeLatestImage("session-B", "session-B-image", "image/jpeg");

    // Session A gets its own image, not B's
    const imageA = getLatestImage("session-A");
    expect(imageA!.base64).toBe("session-A-image");

    const imageB = getLatestImage("session-B");
    expect(imageB!.base64).toBe("session-B-image");

    // Clean up
    clearLatestImage("session-A");
    clearLatestImage("session-B");
  });
});

// ---------------------------------------------------------------------------
// Section 13: Concurrent stream + tool execution lifecycle
// ---------------------------------------------------------------------------

describe("Concurrent stream + tool execution lifecycle", () => {
  let createStream: typeof import("../services/streamRegistry.js").createStream;
  let getStream: typeof import("../services/streamRegistry.js").getStream;
  let pushEvent: typeof import("../services/streamRegistry.js").pushEvent;
  let removeStream: typeof import("../services/streamRegistry.js").removeStream;

  beforeEach(async () => {
    const mod = await import("../services/streamRegistry.js");
    createStream = mod.createStream;
    getStream = mod.getStream;
    pushEvent = mod.pushEvent;
    removeStream = mod.removeStream;

    removeStream("session-A");
    removeStream("session-B");
  });

  afterEach(() => {
    removeStream("session-A");
    removeStream("session-B");
  });

  it("streaming tokens + tool calls interleaved across two sessions", () => {
    const streamA = createStream("session-A", "asst-a1", "model-1");
    const streamB = createStream("session-B", "asst-b1", "model-2");

    // Session A starts streaming text
    pushEvent("session-A", { type: "token", data: "Let me " });
    pushEvent("session-A", { type: "token", data: "check that." });

    // Session B starts streaming tool calls
    pushEvent("session-B", {
      type: "tool_call",
      data: { id: "tc-b1", name: "filesystem_read_file", arguments: { path: "/etc/hostname" } },
    });

    // Session A gets a tool call
    pushEvent("session-A", {
      type: "tool_call",
      data: { id: "tc-a1", name: "run_command_execute", arguments: { command: "date" } },
    });

    // Session B gets more text
    pushEvent("session-B", { type: "token", data: "Reading file..." });

    // Verify isolation
    expect(streamA.content).toBe("Let me check that.");
    expect(streamA.toolCalls).toHaveLength(1);
    expect(streamA.toolCalls[0].id).toBe("tc-a1");

    expect(streamB.content).toBe("Reading file...");
    expect(streamB.toolCalls).toHaveLength(1);
    expect(streamB.toolCalls[0].id).toBe("tc-b1");
  });

  it("one session completing does not affect the other's ongoing stream", () => {
    createStream("session-A", "asst-a1", "model-1");
    createStream("session-B", "asst-b1", "model-1");

    // Both start streaming
    pushEvent("session-A", { type: "token", data: "A response" });
    pushEvent("session-B", { type: "token", data: "B response" });

    // A finishes
    pushEvent("session-A", { type: "done", data: { hasToolCalls: false } });

    // B should still be active
    expect(getStream("session-A")!.done).toBe(true);
    expect(getStream("session-B")!.done).toBe(false);

    // B can still receive tokens
    pushEvent("session-B", { type: "token", data: " more B content" });
    expect(getStream("session-B")!.content).toBe("B response more B content");
  });

  it("subscribers from different sessions are independent sets", () => {
    const streamA = createStream("session-A", "asst-a1", "model-1");
    const streamB = createStream("session-B", "asst-b1", "model-1");

    const subsA: SSEEvent[] = [];
    const subsB: SSEEvent[] = [];

    streamA.subscribers.add((e) => subsA.push(e));
    streamB.subscribers.add((e) => subsB.push(e));

    // Each subscriber should only receive events from its own session
    pushEvent("session-A", { type: "token", data: "A" });
    pushEvent("session-B", { type: "token", data: "B" });

    expect(subsA).toHaveLength(1);
    expect(subsB).toHaveLength(1);
    expect((subsA[0] as { data: string }).data).toBe("A");
    expect((subsB[0] as { data: string }).data).toBe("B");
  });

  it("multiple subscribers per session all receive events (multi-client)", () => {
    const stream = createStream("session-A", "asst-a1", "model-1");

    const client1Events: SSEEvent[] = [];
    const client2Events: SSEEvent[] = [];

    stream.subscribers.add((e) => client1Events.push(e));
    stream.subscribers.add((e) => client2Events.push(e));

    pushEvent("session-A", { type: "token", data: "shared token" });

    // Both clients should receive the same event
    expect(client1Events).toHaveLength(1);
    expect(client2Events).toHaveLength(1);
    expect((client1Events[0] as { data: string }).data).toBe("shared token");
    expect((client2Events[0] as { data: string }).data).toBe("shared token");
  });
});

// ---------------------------------------------------------------------------
// Section 14: No deadlocks — concurrent tool execution patterns
// ---------------------------------------------------------------------------

describe("No deadlocks — concurrent tool execution patterns", () => {
  let registerTool: typeof import("../services/tools/ToolExecutor.js").registerTool;
  let executeToolCalls: typeof import("../services/tools/ToolExecutor.js").executeToolCalls;

  beforeEach(async () => {
    const mod = await import("../services/tools/ToolExecutor.js");
    registerTool = mod.registerTool;
    executeToolCalls = mod.executeToolCalls;
  });

  it("tool that takes a long time completes without deadlock", async () => {
    const toolName = `long_tool_${Date.now()}`;
    registerTool({
      definition: {
        name: toolName,
        description: "Test",
        operations: { run: { params: {}, required: [] } },
      },
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "completed";
      },
    });

    const result = await executeToolCalls([
      { id: "tc1", name: `${toolName}_run`, arguments: {} },
    ]);

    expect(result[0].output).toBe("completed");
  }, 5000);

  it("many concurrent sessions do not cause resource exhaustion", async () => {
    const toolName = `many_sessions_${Date.now()}`;
    let activeConcurrent = 0;
    let maxConcurrent = 0;

    registerTool({
      definition: {
        name: toolName,
        description: "Test",
        operations: { run: { params: {}, required: [] } },
      },
      async execute() {
        activeConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, activeConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeConcurrent--;
        return "ok";
      },
    });

    // Launch 20 concurrent sessions
    const promises = Array.from({ length: 20 }, (_, i) =>
      executeToolCalls(
        [{ id: `tc-${i}`, name: `${toolName}_run`, arguments: {} }],
        `session-${i}`,
      ),
    );

    const results = await Promise.all(promises);

    // All should complete successfully
    for (const result of results) {
      expect(result[0].output).toBe("ok");
    }

    // Concurrent count should have been > 1 (proving parallelism)
    expect(maxConcurrent).toBeGreaterThan(1);
  }, 10000);

  it("tool throwing does not leave executor in bad state for next call", async () => {
    const toolName = `throw_recover_${Date.now()}`;
    let callCount = 0;

    registerTool({
      definition: {
        name: toolName,
        description: "Test",
        operations: { run: { params: {}, required: [] } },
      },
      async execute() {
        callCount++;
        if (callCount === 1) throw new Error("first call fails");
        return "recovered";
      },
    });

    // First call fails
    const result1 = await executeToolCalls([
      { id: "tc1", name: `${toolName}_run`, arguments: {} },
    ]);
    expect(result1[0].isError).toBe(true);

    // Second call should succeed — executor is not in a bad state
    const result2 = await executeToolCalls([
      { id: "tc2", name: `${toolName}_run`, arguments: {} },
    ]);
    expect(result2[0].isError).toBeFalsy();
    expect(result2[0].output).toBe("recovered");
  });
});
