import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage, ToolResult } from "@vladbot/shared";

// Mock all dependencies before importing
vi.mock("../services/db.js", () => ({
  default: { query: vi.fn() },
}));

const mockGetSession = vi.fn();
const mockAddMessage = vi.fn().mockResolvedValue("new-msg-id");
const mockUpdateMessage = vi.fn().mockResolvedValue(undefined);
const mockUpdateSessionTokenUsage = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/sessionStore.js", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  addMessage: (...args: unknown[]) => mockAddMessage(...args),
  updateMessage: (...args: unknown[]) => mockUpdateMessage(...args),
  updateSessionTokenUsage: (...args: unknown[]) => mockUpdateSessionTokenUsage(...args),
  atomicApprove: vi.fn().mockResolvedValue(true),
  getSessionAutoApprove: vi.fn().mockResolvedValue(false),
}));

const mockValidateToolCalls = vi.fn().mockReturnValue([]);
const mockExecuteToolCalls = vi.fn();

vi.mock("../services/tools/index.js", () => ({
  validateToolCalls: (...args: unknown[]) => mockValidateToolCalls(...args),
  executeToolCalls: (...args: unknown[]) => mockExecuteToolCalls(...args),
}));

// Mock AI provider
const mockGenerateStream = vi.fn();
vi.mock("../services/ai/ProviderFactory.js", () => ({
  getProvider: () => ({
    generateStream: mockGenerateStream,
  }),
}));

// Mock stream registry
const mockCreateStream = vi.fn().mockReturnValue({
  sessionId: "s1",
  assistantId: "new-asst",
  content: "",
  model: "gpt-4",
  toolCalls: [],
  hasToolCalls: false,
  done: false,
  aborted: false,
  subscribers: new Set(),
  generation: 1,
  abortController: new AbortController(),
});

const mockContinueStream = vi.fn().mockReturnValue(null);
const mockPushEvent = vi.fn();
const mockRemoveStream = vi.fn();
const mockGetStream = vi.fn();

const mockScheduleRemoval = vi.fn();

vi.mock("../services/streamRegistry.js", () => ({
  createStream: (...args: unknown[]) => mockCreateStream(...args),
  continueStream: (...args: unknown[]) => mockContinueStream(...args),
  pushEvent: (...args: unknown[]) => mockPushEvent(...args),
  removeStream: (...args: unknown[]) => mockRemoveStream(...args),
  getStream: (...args: unknown[]) => mockGetStream(...args),
  scheduleRemoval: (...args: unknown[]) => mockScheduleRemoval(...args),
}));

vi.mock("../services/sessionFiles.js", () => ({
  saveSessionFile: vi.fn(),
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
    SHOWUI_API_URL: "",
  },
}));

vi.mock("../services/autoCompact.js", () => ({
  autoCompactIfNeeded: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/tokenCounter.js", () => ({
  countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  estimateMessageTokens: vi.fn((msg: { content: string; toolCalls?: unknown[]; toolResults?: unknown[] }) => {
    let text = msg.content;
    if (msg.toolCalls) text += JSON.stringify(msg.toolCalls);
    if (msg.toolResults) text += JSON.stringify(msg.toolResults);
    return Math.ceil(text.length / 4);
  }),
}));

const { buildHistoryFromDB, executeToolRound, denyToolRound } = await import(
  "../services/toolLoop.js"
);

beforeEach(() => {
  vi.clearAllMocks();

  // Default: generateStream returns an empty async generator
  mockGenerateStream.mockReturnValue(
    (async function* () {
      yield { type: "text", text: "Response" };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    })(),
  );

  // Default: getStream returns a valid stream object
  mockGetStream.mockReturnValue({
    sessionId: "s1",
    assistantId: "new-asst",
    content: "Response",
    model: "gpt-4",
    toolCalls: [],
    hasToolCalls: false,
    done: true,
    aborted: false,
    subscribers: new Set(),
    generation: 1,
    abortController: new AbortController(),
    requestBody: { model: "gpt-4", messages: [] },
    usage: { inputTokens: 10, outputTokens: 5 },
  });
});

describe("buildHistoryFromDB", () => {
  it("builds history from messages", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: "Hello", timestamp: 1000 },
      { id: "m2", role: "assistant", content: "Hi", timestamp: 1001 },
    ];
    const history = buildHistoryFromDB(messages);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "Hello" });
    expect(history[1]).toEqual({ role: "assistant", content: "Hi" });
  });

  it("includes compaction summary and verbatim tail", () => {
    const messages: ChatMessage[] = [
      { id: "m0", role: "user", content: "Very old", timestamp: 500 },
      { id: "m1", role: "assistant", content: "Very old reply", timestamp: 600 },
      { id: "m2", role: "user", content: "Recent pre-compaction", timestamp: 900 },
      { id: "m3", role: "assistant", content: "Recent reply", timestamp: 1000 },
      { id: "c1", role: "compaction", content: "Summary of old", timestamp: 2000 },
      { id: "m4", role: "user", content: "New message", timestamp: 3000 },
    ];
    const history = buildHistoryFromDB(messages);
    // compaction user + ack + 4 verbatim tail (m0-m3 within VERBATIM_TAIL_COUNT=5) + new user
    expect(history).toHaveLength(7);
    expect(history[0].content).toContain("Summary of old");
    expect(history[1].content).toContain("Understood");
    expect(history[2].content).toBe("Very old");
    expect(history[3].content).toBe("Very old reply");
    expect(history[4].content).toBe("Recent pre-compaction");
    expect(history[5].content).toBe("Recent reply");
    expect(history[6].content).toBe("New message");
  });

  it("limits verbatim tail to VERBATIM_TAIL_COUNT for old compactions (no verbatimCount)", () => {
    // 8 messages before compaction, compaction has no verbatimCount → falls back to VERBATIM_TAIL_COUNT=5
    const messages: ChatMessage[] = [
      { id: "m0", role: "user", content: "Too old 1", timestamp: 100 },
      { id: "m1", role: "assistant", content: "Too old 2", timestamp: 200 },
      { id: "m2", role: "user", content: "Too old 3", timestamp: 300 },
      { id: "m3", role: "assistant", content: "Tail 1", timestamp: 400 },
      { id: "m4", role: "user", content: "Tail 2", timestamp: 500 },
      { id: "m5", role: "assistant", content: "Tail 3", timestamp: 600 },
      { id: "m6", role: "user", content: "Tail 4", timestamp: 700 },
      { id: "m7", role: "assistant", content: "Tail 5", timestamp: 800 },
      { id: "c1", role: "compaction", content: "Summary", timestamp: 2000 },
      { id: "m8", role: "user", content: "New", timestamp: 3000 },
    ];
    const history = buildHistoryFromDB(messages);
    // compaction pair (2) + 5 tail + 1 new = 8
    expect(history).toHaveLength(8);
    expect(history[0].content).toContain("Summary");
    expect(history[2].content).toBe("Tail 1");
    expect(history[6].content).toBe("Tail 5");
    expect(history[7].content).toBe("New");
    // "Too old" messages should NOT appear
    expect(history.every((h) => !h.content.includes("Too old"))).toBe(true);
  });

  it("uses verbatimCount from compaction message when present", () => {
    // 8 messages before compaction, verbatimCount=3 → only last 3 in tail
    const messages: ChatMessage[] = [
      { id: "m0", role: "user", content: "Too old 1", timestamp: 100 },
      { id: "m1", role: "assistant", content: "Too old 2", timestamp: 200 },
      { id: "m2", role: "user", content: "Too old 3", timestamp: 300 },
      { id: "m3", role: "assistant", content: "Too old 4", timestamp: 400 },
      { id: "m4", role: "user", content: "Too old 5", timestamp: 500 },
      { id: "m5", role: "assistant", content: "Tail 1", timestamp: 600 },
      { id: "m6", role: "user", content: "Tail 2", timestamp: 700 },
      { id: "m7", role: "assistant", content: "Tail 3", timestamp: 800 },
      { id: "c1", role: "compaction", content: "Summary", timestamp: 2000, verbatimCount: 3 },
      { id: "m8", role: "user", content: "New", timestamp: 3000 },
    ];
    const history = buildHistoryFromDB(messages);
    // compaction pair (2) + 3 tail + 1 new = 6
    expect(history).toHaveLength(6);
    expect(history[0].content).toContain("Summary");
    expect(history[2].content).toBe("Tail 1");
    expect(history[3].content).toBe("Tail 2");
    expect(history[4].content).toBe("Tail 3");
    expect(history[5].content).toBe("New");
    expect(history.every((h) => !h.content.includes("Too old"))).toBe(true);
  });

  it("verbatimCount=0 means no verbatim tail", () => {
    const messages: ChatMessage[] = [
      { id: "m0", role: "user", content: "Old", timestamp: 100 },
      { id: "m1", role: "assistant", content: "Old reply", timestamp: 200 },
      { id: "c1", role: "compaction", content: "Summary", timestamp: 2000, verbatimCount: 0 },
      { id: "m2", role: "user", content: "New", timestamp: 3000 },
    ];
    const history = buildHistoryFromDB(messages);
    // compaction pair (2) + 0 tail + 1 new = 3
    expect(history).toHaveLength(3);
    expect(history[0].content).toContain("Summary");
    expect(history[2].content).toBe("New");
  });

  it("stops verbatim tail at previous compaction", () => {
    const messages: ChatMessage[] = [
      { id: "c0", role: "compaction", content: "Older summary", timestamp: 500 },
      { id: "m1", role: "user", content: "Mid msg", timestamp: 600 },
      { id: "m2", role: "assistant", content: "Mid reply", timestamp: 700 },
      { id: "c1", role: "compaction", content: "Latest summary", timestamp: 2000 },
      { id: "m3", role: "user", content: "New", timestamp: 3000 },
    ];
    const history = buildHistoryFromDB(messages);
    // Uses c1 (latest). Verbatim tail walks back but stops at c0.
    // So tail = m1, m2. History = c1 pair + m1 + m2 + m3 = 5
    expect(history).toHaveLength(5);
    expect(history[0].content).toContain("Latest summary");
    expect(history[2].content).toBe("Mid msg");
    expect(history[3].content).toBe("Mid reply");
    expect(history[4].content).toBe("New");
    // Older summary should NOT appear
    expect(history.every((h) => !h.content.includes("Older summary"))).toBe(true);
  });

  it("verbatim tail preserves tool calls, results, and images", () => {
    const messages: ChatMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "Checking",
        timestamp: 900,
        toolCalls: [{ id: "tc1", name: "fs", arguments: {} }],
        toolResults: [{ toolCallId: "tc1", output: "ok" }],
      },
      { id: "m2", role: "user", content: "Thanks", timestamp: 1000, images: ["/img.jpg"] },
      { id: "c1", role: "compaction", content: "Summary", timestamp: 2000 },
    ];
    const history = buildHistoryFromDB(messages);
    // compaction pair + 2 tail = 4
    expect(history).toHaveLength(4);
    expect(history[2].toolCalls).toHaveLength(1);
    expect(history[2].toolResults).toHaveLength(1);
    expect(history[3].images).toEqual(["/img.jpg"]);
  });

  it("skips empty tool messages", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: "Hello", timestamp: 1000 },
      { id: "m2", role: "tool", content: "", timestamp: 1001 },
      { id: "m3", role: "assistant", content: "Hi", timestamp: 1002 },
    ];
    const history = buildHistoryFromDB(messages);
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("assistant");
  });

  it("includes tool calls and results without compaction", () => {
    const messages: ChatMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "Let me check",
        timestamp: 1000,
        toolCalls: [{ id: "tc1", name: "test", arguments: {} }],
        toolResults: [{ toolCallId: "tc1", output: "result" }],
      },
    ];
    const history = buildHistoryFromDB(messages);
    expect(history[0].toolCalls).toHaveLength(1);
    expect(history[0].toolResults).toHaveLength(1);
  });

  it("handles empty messages", () => {
    const history = buildHistoryFromDB([]);
    expect(history).toEqual([]);
  });

  it("includes images in history", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: "Look", timestamp: 1000, images: ["/img/1.jpg"] },
    ];
    const history = buildHistoryFromDB(messages);
    expect(history[0].images).toEqual(["/img/1.jpg"]);
  });

  it("handles compaction with no post-compaction messages", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: "A", timestamp: 1000 },
      { id: "m2", role: "assistant", content: "B", timestamp: 1100 },
      { id: "c1", role: "compaction", content: "Summary", timestamp: 2000 },
    ];
    const history = buildHistoryFromDB(messages);
    // compaction pair + 2 tail = 4
    expect(history).toHaveLength(4);
    expect(history[0].content).toContain("Summary");
    expect(history[2].content).toBe("A");
    expect(history[3].content).toBe("B");
  });

  it("deduplicates tool messages with identical toolCallIds", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: "Hello", timestamp: 1000 },
      {
        id: "m2",
        role: "assistant",
        content: "Let me check",
        timestamp: 1001,
        toolCalls: [{ id: "tc1", name: "test", arguments: {} }],
      },
      {
        id: "m3",
        role: "tool",
        content: "",
        timestamp: 1002,
        toolResults: [{ toolCallId: "tc1", output: "result" }],
      },
      {
        id: "m4",
        role: "tool",
        content: "",
        timestamp: 1003,
        toolResults: [{ toolCallId: "tc1", output: "result" }],
      },
      { id: "m5", role: "assistant", content: "Done", timestamp: 1004 },
    ];
    const history = buildHistoryFromDB(messages);
    // user + assistant(toolCalls) + 1 tool (deduped) + assistant = 4
    expect(history).toHaveLength(4);
    const toolMsgs = history.filter((h) => h.role === "tool");
    expect(toolMsgs).toHaveLength(1);
  });

  it("keeps tool messages with different toolCallIds", () => {
    const messages: ChatMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "",
        timestamp: 1000,
        toolCalls: [
          { id: "tc1", name: "a", arguments: {} },
          { id: "tc2", name: "b", arguments: {} },
        ],
      },
      {
        id: "m2",
        role: "tool",
        content: "",
        timestamp: 1001,
        toolResults: [{ toolCallId: "tc1", output: "r1" }],
      },
      {
        id: "m3",
        role: "tool",
        content: "",
        timestamp: 1002,
        toolResults: [{ toolCallId: "tc2", output: "r2" }],
      },
    ];
    const history = buildHistoryFromDB(messages);
    const toolMsgs = history.filter((h) => h.role === "tool");
    expect(toolMsgs).toHaveLength(2);
  });

  it("verbatim tail does not split tool-call sequences", () => {
    // Assistant with tool calls at tailStart boundary, tool message right after
    const messages: ChatMessage[] = [
      { id: "m0", role: "user", content: "Old", timestamp: 100 },
      {
        id: "m1",
        role: "assistant",
        content: "Calling tool",
        timestamp: 200,
        toolCalls: [{ id: "tc1", name: "fs", arguments: {} }],
      },
      {
        id: "m2",
        role: "tool",
        content: "",
        timestamp: 300,
        toolResults: [{ toolCallId: "tc1", output: "ok" }],
      },
      { id: "m3", role: "user", content: "Recent", timestamp: 400 },
      { id: "m4", role: "assistant", content: "Reply", timestamp: 500 },
      // verbatimCount=2 would normally start at m3, but if it landed on a tool
      // message it would walk back to include the assistant
      { id: "c1", role: "compaction", content: "Summary", timestamp: 2000, verbatimCount: 3 },
      { id: "m5", role: "user", content: "New", timestamp: 3000 },
    ];
    const history = buildHistoryFromDB(messages);
    // Tail starts at m2 (tool), walks back to m1 (assistant). So tail = m1,m2,m3,m4
    // compaction pair(2) + 4 tail + 1 new = 7
    // Actually verbatimCount=3 → starts at index 3 (m3). m3 is user, no walk-back needed.
    // tail = m3, m4. compaction pair(2) + 2 tail? Wait let me recalculate.
    // compactionIdx=5 (c1). tailCount=3. tailStart = max(0, 5-3) = 2 (m2).
    // m2 is tool → walk back → tailStart=1 (m1, assistant).
    // So tail = m1,m2,m3,m4 (indices 1-4). compaction pair(2) + 4 tail + 1 new = 7.
    expect(history).toHaveLength(7);
    // m1 (assistant with toolCalls) should be in the tail
    expect(history[2].content).toBe("Calling tool");
    expect(history[2].toolCalls).toHaveLength(1);
    // m2 (tool results) should follow
    expect(history[3].toolResults).toHaveLength(1);
  });

  it("skips orphaned tool messages after compaction", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: "Old", timestamp: 100 },
      { id: "c1", role: "compaction", content: "Summary", timestamp: 2000 },
      // Orphaned tool message — its parent assistant message was before compaction
      {
        id: "m2",
        role: "tool",
        content: "",
        timestamp: 2001,
        toolResults: [{ toolCallId: "tc-orphan", output: "stale" }],
      },
      { id: "m3", role: "user", content: "New question", timestamp: 3000 },
    ];
    const history = buildHistoryFromDB(messages);
    // compaction pair(2) + verbatim tail (m1 = 1) + post-compaction skips orphan, includes m3 = 1
    // Total = 4
    expect(history).toHaveLength(4);
    // No orphaned tool message in the output
    expect(history.every((h) => h.role !== "tool")).toBe(true);
    expect(history[3].content).toBe("New question");
  });
});

describe("executeToolRound", () => {
  const makeSession = (messages: ChatMessage[]) => ({
    id: "s1",
    title: "Test",
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
    messages,
  });

  it("throws for missing session", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(
      executeToolRound("s1", "m1", "gpt-4", "deepseek"),
    ).rejects.toThrow("Session not found");
  });

  it("throws for missing message", async () => {
    mockGetSession.mockResolvedValue(makeSession([]));
    await expect(
      executeToolRound("s1", "m1", "gpt-4", "deepseek"),
    ).rejects.toThrow("Message not found");
  });

  it("returns early if message has no tool calls", async () => {
    mockGetSession.mockResolvedValue(
      makeSession([{ id: "m1", role: "assistant", content: "Hi", timestamp: 1 }]),
    );
    await executeToolRound("s1", "m1", "gpt-4", "deepseek");
    expect(mockExecuteToolCalls).not.toHaveBeenCalled();
  });

  it("executes tools and saves results", async () => {
    const toolCalls = [{ id: "tc1", name: "test_op", arguments: {} }];
    const session = makeSession([
      { id: "m1", role: "user", content: "Hello", timestamp: 1 },
      {
        id: "m2",
        role: "assistant",
        content: "Let me check",
        timestamp: 2,
        toolCalls,
        approvalStatus: "approved" as const,
      },
    ]);

    // First call: executeToolRound reads session with tool calls
    mockGetSession.mockResolvedValueOnce(session);
    // Second call: streamNextRound re-reads session with results
    mockGetSession.mockResolvedValueOnce({
      ...session,
      messages: [
        ...session.messages,
        { id: "tool-msg", role: "tool", content: "", timestamp: 3, toolResults: [{ toolCallId: "tc1", output: "done" }] },
      ],
    });

    mockExecuteToolCalls.mockResolvedValue([
      { toolCallId: "tc1", output: "done" },
    ]);

    await executeToolRound("s1", "m2", "gpt-4", "deepseek");

    // Should have executed tools
    expect(mockExecuteToolCalls).toHaveBeenCalledWith([toolCalls[0]], "s1");

    // Should have updated the message with results
    expect(mockUpdateMessage).toHaveBeenCalledWith("m2", {
      approvalStatus: "approved",
      toolResults: [{ toolCallId: "tc1", output: "done" }],
    });

    // Should have created a tool message
    expect(mockAddMessage).toHaveBeenCalled();

    // Should have pushed tool_result events
    expect(mockPushEvent).toHaveBeenCalledWith("s1", {
      type: "tool_result",
      data: { toolCallId: "tc1", output: "done" },
    });
  });

  it("cancels remaining tools on error", async () => {
    const toolCalls = [
      { id: "tc1", name: "test_a", arguments: {} },
      { id: "tc2", name: "test_b", arguments: {} },
    ];
    const session = makeSession([
      {
        id: "m2",
        role: "assistant",
        content: "",
        timestamp: 2,
        toolCalls,
        approvalStatus: "approved" as const,
      },
    ]);

    mockGetSession.mockResolvedValueOnce(session);
    mockGetSession.mockResolvedValueOnce({
      ...session,
      messages: [
        ...session.messages,
        { id: "tool-msg", role: "tool", content: "", timestamp: 3, toolResults: [] },
      ],
    });

    mockExecuteToolCalls.mockResolvedValue([
      { toolCallId: "tc1", output: "Error: failed", isError: true },
    ]);

    await executeToolRound("s1", "m2", "gpt-4", "deepseek");

    // Second tool should be cancelled
    const updateCall = mockUpdateMessage.mock.calls[0];
    const results = updateCall[1].toolResults as ToolResult[];
    expect(results).toHaveLength(2);
    expect(results[0].isError).toBe(true);
    expect(results[1].output).toContain("Cancelled");
  });

  it("handles validation errors", async () => {
    const toolCalls = [{ id: "tc1", name: "unknown_tool", arguments: {} }];
    const session = makeSession([
      {
        id: "m2",
        role: "assistant",
        content: "",
        timestamp: 2,
        toolCalls,
        approvalStatus: "approved" as const,
      },
    ]);

    mockGetSession.mockResolvedValueOnce(session);
    mockGetSession.mockResolvedValueOnce({
      ...session,
      messages: [
        ...session.messages,
        { id: "tool-msg", role: "tool", content: "", timestamp: 3, toolResults: [] },
      ],
    });

    mockValidateToolCalls.mockReturnValueOnce([
      { toolCallId: "tc1", output: "Unknown tool", isError: true },
    ]);

    await executeToolRound("s1", "m2", "gpt-4", "deepseek");

    // Should NOT have executed tools
    expect(mockExecuteToolCalls).not.toHaveBeenCalled();

    // Should have updated message with validation errors
    expect(mockUpdateMessage).toHaveBeenCalled();

    // Should have added a tool message
    expect(mockAddMessage).toHaveBeenCalled();
  });

  it("saves assistant message to DB BEFORE pushing done event", async () => {
    const toolCalls = [{ id: "tc1", name: "test_op", arguments: {} }];
    const session = makeSession([
      { id: "m1", role: "user", content: "Hello", timestamp: 1 },
      {
        id: "m2",
        role: "assistant",
        content: "Let me check",
        timestamp: 2,
        toolCalls,
        approvalStatus: "approved" as const,
      },
    ]);

    mockGetSession.mockResolvedValueOnce(session);
    mockGetSession.mockResolvedValueOnce({
      ...session,
      messages: [
        ...session.messages,
        { id: "tool-msg", role: "tool", content: "", timestamp: 3, toolResults: [{ toolCallId: "tc1", output: "done" }] },
      ],
    });

    mockExecuteToolCalls.mockResolvedValue([
      { toolCallId: "tc1", output: "done" },
    ]);

    // Track call order
    const callOrder: string[] = [];
    mockAddMessage.mockImplementation(async (_sid: string, msg: ChatMessage) => {
      if (msg.role === "assistant") callOrder.push("addMessage");
      return "new-id";
    });
    mockPushEvent.mockImplementation((_sid: string, event: { type: string }) => {
      if (event.type === "done") callOrder.push("pushDone");
    });

    await executeToolRound("s1", "m2", "gpt-4", "deepseek");

    // addMessage for the assistant must happen before the done event
    const addIdx = callOrder.indexOf("addMessage");
    const doneIdx = callOrder.indexOf("pushDone");
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeLessThan(doneIdx);
  });

  it("uses scheduleRemoval instead of raw setTimeout", async () => {
    const toolCalls = [{ id: "tc1", name: "test_op", arguments: {} }];
    const session = makeSession([
      { id: "m1", role: "user", content: "Hello", timestamp: 1 },
      {
        id: "m2",
        role: "assistant",
        content: "Let me check",
        timestamp: 2,
        toolCalls,
        approvalStatus: "approved" as const,
      },
    ]);

    mockGetSession.mockResolvedValueOnce(session);
    mockGetSession.mockResolvedValueOnce({
      ...session,
      messages: [
        ...session.messages,
        { id: "tool-msg", role: "tool", content: "", timestamp: 3, toolResults: [{ toolCallId: "tc1", output: "done" }] },
      ],
    });

    mockExecuteToolCalls.mockResolvedValue([
      { toolCallId: "tc1", output: "done" },
    ]);

    await executeToolRound("s1", "m2", "gpt-4", "deepseek");

    // scheduleRemoval must be used (not raw setTimeout + removeStream)
    expect(mockScheduleRemoval).toHaveBeenCalledWith("s1");
    expect(mockRemoveStream).not.toHaveBeenCalled();
  });

  it("respects MAX_TOOL_ROUNDS", async () => {
    await executeToolRound("s1", "m2", "gpt-4", "deepseek", undefined, 10);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("saves llmRequest and llmResponse with assistant message", async () => {
    const toolCalls = [{ id: "tc1", name: "test_op", arguments: {} }];
    const session = makeSession([
      { id: "m1", role: "user", content: "Hello", timestamp: 1 },
      {
        id: "m2",
        role: "assistant",
        content: "Let me check",
        timestamp: 2,
        toolCalls,
        approvalStatus: "approved" as const,
      },
    ]);

    mockGetSession.mockResolvedValueOnce(session);
    mockGetSession.mockResolvedValueOnce({
      ...session,
      messages: [
        ...session.messages,
        { id: "tool-msg", role: "tool", content: "", timestamp: 3, toolResults: [{ toolCallId: "tc1", output: "done" }] },
      ],
    });

    mockExecuteToolCalls.mockResolvedValue([
      { toolCallId: "tc1", output: "done" },
    ]);

    // getStream returns stream with requestBody and usage
    mockGetStream.mockReturnValue({
      sessionId: "s1",
      assistantId: "new-asst",
      content: "Response",
      model: "gpt-4",
      toolCalls: [],
      hasToolCalls: false,
      done: true,
      subscribers: new Set(),
      requestBody: { model: "gpt-4", messages: [{ role: "user", content: "Hello" }] },
      usage: { inputTokens: 20, outputTokens: 10 },
    });

    await executeToolRound("s1", "m2", "gpt-4", "deepseek");

    // The second addMessage call (assistant message from streamNextRound) should include llmRequest/llmResponse
    const addCalls = mockAddMessage.mock.calls;
    // First call is tool message, second is assistant message
    const assistantCall = addCalls.find(
      (call: unknown[]) => (call[1] as ChatMessage).role === "assistant",
    );
    expect(assistantCall).toBeDefined();
    const savedMsg = assistantCall![1] as ChatMessage;
    expect(savedMsg.llmRequest).toEqual({ model: "gpt-4", messages: [{ role: "user", content: "Hello" }] });
    expect(savedMsg.llmResponse).toEqual({
      content: "Response",
      toolCalls: undefined,
      usage: { inputTokens: 20, outputTokens: 10 },
    });
  });
});

describe("denyToolRound", () => {
  const makeSession = (messages: ChatMessage[]) => ({
    id: "s1",
    title: "Test",
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
    messages,
  });

  it("throws for missing session", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(denyToolRound("s1", "m1")).rejects.toThrow("Session not found");
  });

  it("throws for missing message", async () => {
    mockGetSession.mockResolvedValue(makeSession([]));
    await expect(denyToolRound("s1", "m1")).rejects.toThrow("Message not found");
  });

  it("creates denial results for all tool calls", async () => {
    const toolCalls = [
      { id: "tc1", name: "test_a", arguments: {} },
      { id: "tc2", name: "test_b", arguments: {} },
    ];
    mockGetSession.mockResolvedValue(
      makeSession([
        {
          id: "m2",
          role: "assistant",
          content: "",
          timestamp: 2,
          toolCalls,
          approvalStatus: "pending" as const,
        },
      ]),
    );

    await denyToolRound("s1", "m2");

    // Should update message with denied status + results
    expect(mockUpdateMessage).toHaveBeenCalledWith("m2", {
      approvalStatus: "denied",
      toolResults: [
        { toolCallId: "tc1", output: "Tool call denied by user", isError: true },
        { toolCallId: "tc2", output: "Tool call denied by user", isError: true },
      ],
    });

    // Should create a tool message
    expect(mockAddMessage).toHaveBeenCalledWith("s1", expect.objectContaining({
      role: "tool",
      toolResults: expect.arrayContaining([
        expect.objectContaining({ toolCallId: "tc1", isError: true }),
      ]),
    }));
  });

  it("returns early if message has no tool calls", async () => {
    mockGetSession.mockResolvedValue(
      makeSession([{ id: "m1", role: "assistant", content: "Hi", timestamp: 1 }]),
    );
    await denyToolRound("s1", "m1");
    expect(mockUpdateMessage).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });
});
