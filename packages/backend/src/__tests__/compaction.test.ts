import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage } from "@vladbot/shared";

// --- Mocks ---

const mockGetSession = vi.fn();
const mockAddMessage = vi.fn();

vi.mock("../services/sessionStore.js", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  addMessage: (...args: unknown[]) => mockAddMessage(...args),
}));

const mockGenerateResponse = vi.fn();

vi.mock("../services/ai/ProviderFactory.js", () => ({
  getProvider: () => ({
    generateResponse: mockGenerateResponse,
  }),
}));

const mockGetRuntimeSetting = vi.fn().mockResolvedValue("40");

vi.mock("../config/runtimeSettings.js", () => ({
  getRuntimeSetting: (...args: unknown[]) => mockGetRuntimeSetting(...args),
}));

// Mock tokenCounter: ~4 chars per token
function mockEstimateTokens(msg: { content: string; toolCalls?: unknown[]; toolResults?: unknown[] }) {
  let text = msg.content;
  if (msg.toolCalls) text += JSON.stringify(msg.toolCalls);
  if (msg.toolResults) text += JSON.stringify(msg.toolResults);
  return Math.ceil(text.length / 4);
}

vi.mock("../services/tokenCounter.js", () => ({
  countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  estimateMessageTokens: vi.fn((msg: { content: string; toolCalls?: unknown[]; toolResults?: unknown[] }) => mockEstimateTokens(msg)),
  estimateMessageTokensWithCollapsing: vi.fn((msg: { content: string; toolCalls?: unknown[]; toolResults?: unknown[] }) => mockEstimateTokens(msg)),
  findLatestBrowserContentId: vi.fn(() => undefined),
}));

// Mock SnapshotStore for ContextManager tests
const mockCreateSnapshot = vi.fn();
const mockGetActiveSnapshot = vi.fn();
const mockSetActiveSnapshot = vi.fn();
const mockUpdateSessionTokenCount = vi.fn();
const mockGetSessionTokenCount = vi.fn();
const mockGetMessagesByIds = vi.fn();

vi.mock("../services/context/SnapshotStore.js", () => ({
  createSnapshot: (...args: unknown[]) => mockCreateSnapshot(...args),
  getActiveSnapshot: (...args: unknown[]) => mockGetActiveSnapshot(...args),
  setActiveSnapshot: (...args: unknown[]) => mockSetActiveSnapshot(...args),
  updateSessionTokenCount: (...args: unknown[]) => mockUpdateSessionTokenCount(...args),
  getSessionTokenCount: (...args: unknown[]) => mockGetSessionTokenCount(...args),
  getMessagesByIds: (...args: unknown[]) => mockGetMessagesByIds(...args),
}));

const { estimateMessageTokens } = await import("../services/tokenCounter.js");
const {
  buildHistoryFromDB,
  getLLMContext,
  computeDisplayType,
  computeToolStatuses,
  enrichMessageForDisplay,
  performCompaction,
  autoCompactIfNeeded,
} = await import("../services/context/index.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveSnapshot.mockResolvedValue(null);
  mockGetSessionTokenCount.mockResolvedValue(0);
});

// --- Helpers ---

function makeMsg(
  overrides: Partial<ChatMessage> & { role: ChatMessage["role"]; content: string },
  index: number,
): ChatMessage {
  return {
    id: `msg-${index}`,
    timestamp: 1000 + index * 100,
    ...overrides,
  };
}

function makeSession(messages: ChatMessage[]) {
  return {
    id: "sess-1",
    title: "Test",
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
    messages,
  };
}

describe("estimateMessageTokens", () => {
  it("counts content tokens", () => {
    const msg = makeMsg({ role: "user", content: "Hello world" }, 0);
    // "Hello world" = 11 chars, ceil(11/4) = 3
    expect(estimateMessageTokens(msg)).toBe(3);
  });

  it("includes tool calls in count", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "X",
      toolCalls: [{ id: "tc1", name: "test", arguments: { a: 1 } }],
    }, 0);
    const tokens = estimateMessageTokens(msg);
    // Content "X" + serialized toolCalls > just "X"
    expect(tokens).toBeGreaterThan(1);
  });

  it("includes tool results in count", () => {
    const msg = makeMsg({
      role: "tool",
      content: "",
      toolResults: [{ toolCallId: "tc1", output: "some output here" }],
    }, 0);
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(0);
  });
});

// =========================================================================
// ContextManager Tests
// =========================================================================

describe("buildHistoryFromDB", () => {
  it("returns empty array for empty messages", () => {
    const result = buildHistoryFromDB([]);
    expect(result).toEqual([]);
  });

  it("includes all messages when no compaction exists", () => {
    const messages = [
      makeMsg({ role: "user", content: "Hello" }, 0),
      makeMsg({ role: "assistant", content: "Hi there" }, 1),
      makeMsg({ role: "user", content: "How are you?" }, 2),
    ];
    const result = buildHistoryFromDB(messages);

    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("Hello");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("user");
  });

  it("formats compaction as user/assistant summary pair", () => {
    const messages = [
      makeMsg({ role: "compaction", content: "Previous conversation summary" }, 0),
      makeMsg({ role: "user", content: "Continue from here" }, 1),
      makeMsg({ role: "assistant", content: "OK" }, 2),
    ];
    const result = buildHistoryFromDB(messages);

    // Should have: user (summary), assistant (ack), user, assistant = 4 messages
    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("Summary of conversation");
    expect(result[0].content).toContain("Previous conversation summary");
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toContain("Understood");
  });

  it("includes verbatim tail messages before compaction", () => {
    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
      makeMsg({ role: "compaction", content: "Summary", verbatimCount: 2 }, 4),
      makeMsg({ role: "user", content: "E" }, 5),
    ];
    const result = buildHistoryFromDB(messages);

    // Should have: user (summary), assistant (ack), C, D (verbatim), E (after compaction)
    expect(result).toHaveLength(5);
    expect(result[2].content).toBe("C");
    expect(result[3].content).toBe("D");
    expect(result[4].content).toBe("E");
  });

  it("skips empty tool messages", () => {
    const messages = [
      makeMsg({ role: "user", content: "Do something" }, 0),
      makeMsg({ role: "assistant", content: "OK", toolCalls: [{ id: "tc1", name: "test", arguments: {} }] }, 1),
      makeMsg({ role: "tool", content: "" }, 2), // Empty tool message
      makeMsg({ role: "assistant", content: "Done" }, 3),
    ];
    const result = buildHistoryFromDB(messages);

    // Empty tool message should be skipped
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
  });

  it("includes tool messages with results", () => {
    const messages = [
      makeMsg({ role: "user", content: "Do something" }, 0),
      makeMsg({ role: "assistant", content: "OK", toolCalls: [{ id: "tc1", name: "test", arguments: {} }] }, 1),
      makeMsg({ role: "tool", content: "", toolResults: [{ toolCallId: "tc1", output: "Result" }] }, 2),
      makeMsg({ role: "assistant", content: "Done" }, 3),
    ];
    const result = buildHistoryFromDB(messages);

    expect(result).toHaveLength(4);
    expect(result[2].role).toBe("tool");
    expect(result[2].toolResults?.[0].output).toBe("Result");
  });
});

describe("getLLMContext", () => {
  it("returns empty array for non-existent session", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const result = await getLLMContext("nonexistent");

    expect(result).toEqual([]);
  });

  it("uses buildHistoryFromDB when no snapshot exists", async () => {
    const messages = [
      makeMsg({ role: "user", content: "Hello" }, 0),
      makeMsg({ role: "assistant", content: "Hi" }, 1),
    ];
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGetActiveSnapshot.mockResolvedValueOnce(null);

    const result = await getLLMContext("sess-1");

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("Hello");
  });

  it("uses snapshot when available", async () => {
    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
      makeMsg({ role: "user", content: "E" }, 4),
    ];
    const snapshot = {
      id: "snap-1",
      sessionId: "sess-1",
      summary: "Summary of A and B",
      summaryTokenCount: 10,
      verbatimMessageIds: ["msg-2", "msg-3"],
      verbatimTokenCount: 5,
      totalTokenCount: 15,
      triggerTokenCount: 100,
      modelUsed: "model-1",
      createdAt: new Date(),
    };

    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGetActiveSnapshot.mockResolvedValueOnce(snapshot);
    mockGetMessagesByIds.mockResolvedValueOnce([
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
    ]);

    const result = await getLLMContext("sess-1");

    // Should have: user (summary), assistant (ack), C, D (verbatim), E (after snapshot)
    expect(result.length).toBeGreaterThanOrEqual(4);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("Summary of A and B");
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toContain("Understood");
  });
});

describe("computeDisplayType", () => {
  it("returns 'user' for user messages", () => {
    const msg = makeMsg({ role: "user", content: "Hello" }, 0);
    expect(computeDisplayType(msg)).toBe("user");
  });

  it("returns 'assistant' for assistant messages", () => {
    const msg = makeMsg({ role: "assistant", content: "Hi" }, 0);
    expect(computeDisplayType(msg)).toBe("assistant");
  });

  it("returns 'tool_result' for tool messages", () => {
    const msg = makeMsg({ role: "tool", content: "" }, 0);
    expect(computeDisplayType(msg)).toBe("tool_result");
  });

  it("returns 'context_summary' for compaction messages", () => {
    const msg = makeMsg({ role: "compaction", content: "Summary" }, 0);
    expect(computeDisplayType(msg)).toBe("context_summary");
  });
});

describe("computeToolStatuses", () => {
  it("returns undefined for messages without tool calls", () => {
    const msg = makeMsg({ role: "assistant", content: "Hi" }, 0);
    expect(computeToolStatuses(msg)).toBeUndefined();
  });

  it("returns 'pending' when approval is pending and no results", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "Let me check",
      toolCalls: [{ id: "tc1", name: "test", arguments: {} }],
      approvalStatus: "pending",
    }, 0);

    const statuses = computeToolStatuses(msg);

    expect(statuses).toEqual({ tc1: "pending" });
  });

  it("returns 'done' when tool has result", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "Let me check",
      toolCalls: [{ id: "tc1", name: "test", arguments: {} }],
      toolResults: [{ toolCallId: "tc1", output: "Result" }],
      approvalStatus: "approved",
    }, 0);

    const statuses = computeToolStatuses(msg);

    expect(statuses).toEqual({ tc1: "done" });
  });

  it("returns 'cancelled' when approval is denied", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "Let me check",
      toolCalls: [{ id: "tc1", name: "test", arguments: {} }],
      approvalStatus: "denied",
    }, 0);

    const statuses = computeToolStatuses(msg);

    expect(statuses).toEqual({ tc1: "cancelled" });
  });

  it("returns 'executing' for the currently executing tool", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "Let me check",
      toolCalls: [
        { id: "tc1", name: "test1", arguments: {} },
        { id: "tc2", name: "test2", arguments: {} },
      ],
      toolResults: [{ toolCallId: "tc1", output: "Result1" }],
      approvalStatus: "approved",
    }, 0);

    const statuses = computeToolStatuses(msg);

    expect(statuses?.tc1).toBe("done");
    expect(statuses?.tc2).toBe("executing");
  });

  it("returns 'waiting' for tools after the executing one", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "Let me check",
      toolCalls: [
        { id: "tc1", name: "test1", arguments: {} },
        { id: "tc2", name: "test2", arguments: {} },
        { id: "tc3", name: "test3", arguments: {} },
      ],
      toolResults: [{ toolCallId: "tc1", output: "Result1" }],
      approvalStatus: "approved",
    }, 0);

    const statuses = computeToolStatuses(msg);

    expect(statuses?.tc1).toBe("done");
    expect(statuses?.tc2).toBe("executing");
    expect(statuses?.tc3).toBe("waiting");
  });

  it("returns 'cancelled' for remaining tools after error", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "Let me check",
      toolCalls: [
        { id: "tc1", name: "test1", arguments: {} },
        { id: "tc2", name: "test2", arguments: {} },
      ],
      toolResults: [{ toolCallId: "tc1", output: "Error", isError: true }],
      approvalStatus: "approved",
    }, 0);

    const statuses = computeToolStatuses(msg);

    expect(statuses?.tc1).toBe("done");
    expect(statuses?.tc2).toBe("cancelled");
  });
});

describe("enrichMessageForDisplay", () => {
  it("adds displayType to message", () => {
    const msg = makeMsg({ role: "user", content: "Hello" }, 0);
    const enriched = enrichMessageForDisplay(msg);

    expect(enriched.displayType).toBe("user");
  });

  it("adds toolStatuses to assistant messages with tool calls", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "Let me check",
      toolCalls: [{ id: "tc1", name: "test", arguments: {} }],
      approvalStatus: "pending",
    }, 0);
    const enriched = enrichMessageForDisplay(msg);

    expect(enriched.displayType).toBe("assistant");
    expect(enriched.toolStatuses).toEqual({ tc1: "pending" });
  });

  it("does not add toolStatuses to non-assistant messages", () => {
    const msg = makeMsg({ role: "user", content: "Hello" }, 0);
    const enriched = enrichMessageForDisplay(msg);

    expect(enriched.toolStatuses).toBeUndefined();
  });
});

describe("performCompaction", () => {
  it("throws when session is not found", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    await expect(
      performCompaction("nonexistent", "model-1", "anthropic", 100_000),
    ).rejects.toThrow("Session not found");
  });

  it("throws when fewer than 4 messages", async () => {
    const messages = [
      makeMsg({ role: "user", content: "Hello" }, 0),
      makeMsg({ role: "assistant", content: "Hi" }, 1),
      makeMsg({ role: "user", content: "How are you?" }, 2),
    ];
    mockGetSession.mockResolvedValueOnce(makeSession(messages));

    await expect(
      performCompaction("sess-1", "model-1", "anthropic", 100_000),
    ).rejects.toThrow("Not enough messages to compact");
  });

  it("creates a snapshot and compaction message", async () => {
    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
    ];
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "Summary of A and B",
      toolCalls: [],
    });
    mockCreateSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      sessionId: "sess-1",
      summary: "Summary of A and B",
      summaryTokenCount: 10,
      verbatimMessageIds: ["msg-2", "msg-3"],
      verbatimTokenCount: 5,
      totalTokenCount: 15,
      triggerTokenCount: 0,
      modelUsed: "model-1",
      createdAt: new Date(),
    });
    mockSetActiveSnapshot.mockResolvedValueOnce(undefined);
    mockUpdateSessionTokenCount.mockResolvedValueOnce(undefined);
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await performCompaction("sess-1", "model-1", "anthropic", 100_000);

    expect(result.snapshot.id).toBe("snap-1");
    expect(result.compactionMessage.role).toBe("compaction");
    expect(result.compactionMessage.displayType).toBe("context_summary");
    expect(result.summary).toBe("Summary of A and B");
    expect(mockCreateSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSetActiveSnapshot).toHaveBeenCalledWith("sess-1", "snap-1");
  });

  it("filters out existing compaction messages before summarizing", async () => {
    const messages = [
      makeMsg({ role: "compaction", content: "Old summary" }, 0),
      makeMsg({ role: "user", content: "A" }, 1),
      makeMsg({ role: "assistant", content: "B" }, 2),
      makeMsg({ role: "user", content: "C" }, 3),
      makeMsg({ role: "assistant", content: "D" }, 4),
    ];
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "New summary",
      toolCalls: [],
    });
    mockCreateSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      sessionId: "sess-1",
      summary: "New summary",
      summaryTokenCount: 10,
      verbatimMessageIds: ["msg-3", "msg-4"],
      verbatimTokenCount: 5,
      totalTokenCount: 15,
      triggerTokenCount: 0,
      modelUsed: "model-1",
      createdAt: new Date(),
    });
    mockSetActiveSnapshot.mockResolvedValueOnce(undefined);
    mockUpdateSessionTokenCount.mockResolvedValueOnce(undefined);
    mockAddMessage.mockResolvedValueOnce(undefined);

    await performCompaction("sess-1", "model-1", "anthropic", 100_000);

    // Should not include the old compaction message in the summarization
    const summaryInput = mockGenerateResponse.mock.calls[0][0][0].content;
    expect(summaryInput).not.toContain("Old summary");
  });

  it("stores verbatimCount on the compaction message", async () => {
    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
    ];
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "Summary",
      toolCalls: [],
    });
    mockCreateSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      sessionId: "sess-1",
      summary: "Summary",
      summaryTokenCount: 5,
      verbatimMessageIds: ["msg-2", "msg-3"],
      verbatimTokenCount: 5,
      totalTokenCount: 10,
      triggerTokenCount: 0,
      modelUsed: "model-1",
      createdAt: new Date(),
    });
    mockSetActiveSnapshot.mockResolvedValueOnce(undefined);
    mockUpdateSessionTokenCount.mockResolvedValueOnce(undefined);
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await performCompaction("sess-1", "model-1", "anthropic", 100_000);

    expect(result.compactionMessage.verbatimCount).toBe(2);
  });

  it("stores rawTokenCount from LLM usage on compaction message", async () => {
    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
    ];
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "Summary",
      toolCalls: [],
      usage: { inputTokens: 500, outputTokens: 42 },
    });
    mockCreateSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      sessionId: "sess-1",
      summary: "Summary",
      summaryTokenCount: 5,
      verbatimMessageIds: ["msg-2", "msg-3"],
      verbatimTokenCount: 5,
      totalTokenCount: 10,
      triggerTokenCount: 0,
      modelUsed: "model-1",
      createdAt: new Date(),
    });
    mockSetActiveSnapshot.mockResolvedValueOnce(undefined);
    mockUpdateSessionTokenCount.mockResolvedValueOnce(undefined);
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await performCompaction("sess-1", "model-1", "anthropic", 100_000);

    expect(result.compactionMessage.rawTokenCount).toBe(42);
    expect(result.compactionMessage.tokenCount).toBeGreaterThan(0);
  });

  it("returns newTokenUsage with snapshot total tokens", async () => {
    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
    ];
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "Summary text here",
      toolCalls: [],
    });
    mockCreateSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      sessionId: "sess-1",
      summary: "Summary text here",
      summaryTokenCount: 10,
      verbatimMessageIds: ["msg-2", "msg-3"],
      verbatimTokenCount: 8,
      totalTokenCount: 18,
      triggerTokenCount: 0,
      modelUsed: "model-1",
      createdAt: new Date(),
    });
    mockSetActiveSnapshot.mockResolvedValueOnce(undefined);
    mockUpdateSessionTokenCount.mockResolvedValueOnce(undefined);
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await performCompaction("sess-1", "model-1", "anthropic", 100_000);

    expect(result.newTokenUsage).toBeDefined();
    expect(result.newTokenUsage.inputTokens).toBe(18); // snapshot.totalTokenCount
    expect(result.newTokenUsage.outputTokens).toBe(0);
  });

  it("appends verbatim note to compaction message content", async () => {
    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
    ];
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "Summary of conversation",
      toolCalls: [],
    });
    mockCreateSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      sessionId: "sess-1",
      summary: "Summary of conversation",
      summaryTokenCount: 10,
      verbatimMessageIds: ["msg-2", "msg-3"],
      verbatimTokenCount: 5,
      totalTokenCount: 15,
      triggerTokenCount: 0,
      modelUsed: "model-1",
      createdAt: new Date(),
    });
    mockSetActiveSnapshot.mockResolvedValueOnce(undefined);
    mockUpdateSessionTokenCount.mockResolvedValueOnce(undefined);
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await performCompaction("sess-1", "model-1", "anthropic", 100_000);

    expect(result.compactionMessage.content).toContain("Summary of conversation");
    expect(result.compactionMessage.content).toContain("Last 2 messages preserved verbatim");
  });

  it("reads compaction_verbatim_budget from runtime settings", async () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ role: i % 2 === 0 ? "user" : "assistant", content: "X" }, i),
    );
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({ text: "Summary", toolCalls: [] });
    mockCreateSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      sessionId: "sess-1",
      summary: "Summary",
      summaryTokenCount: 5,
      verbatimMessageIds: [],
      verbatimTokenCount: 0,
      totalTokenCount: 5,
      triggerTokenCount: 0,
      modelUsed: "model-1",
      createdAt: new Date(),
    });
    mockSetActiveSnapshot.mockResolvedValueOnce(undefined);
    mockUpdateSessionTokenCount.mockResolvedValueOnce(undefined);
    mockAddMessage.mockResolvedValueOnce(undefined);

    await performCompaction("sess-1", "model-1", "anthropic", 100_000);

    expect(mockGetRuntimeSetting).toHaveBeenCalledWith("compaction_verbatim_budget");
  });
});

describe("autoCompactIfNeeded", () => {
  it("returns null when usage is below threshold", async () => {
    // Mock threshold to 90% for this test
    mockGetRuntimeSetting.mockResolvedValueOnce("90");

    // gemini-2.0-flash has 1M context window
    // 50% usage = 500K tokens, below 90% threshold
    const result = await autoCompactIfNeeded(
      "sess-1",
      "gemini-2.0-flash",
      "google",
      { inputTokens: 400_000, outputTokens: 100_000 },
    );

    expect(result).toBeNull();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("triggers compaction when total tokens exceed threshold", async () => {
    // Mock threshold to 90%
    mockGetRuntimeSetting.mockResolvedValueOnce("90");

    // deepseek-chat has 65536 context window
    // 90% = 58982 tokens
    // Set up mocks for compaction
    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
    ];
    mockGetRuntimeSetting.mockResolvedValueOnce("40"); // for compaction verbatim budget
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "Summary",
      toolCalls: [],
    });
    mockCreateSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      sessionId: "sess-1",
      summary: "Summary",
      summaryTokenCount: 5,
      verbatimMessageIds: ["msg-2", "msg-3"],
      verbatimTokenCount: 5,
      totalTokenCount: 10,
      triggerTokenCount: 0,
      modelUsed: "deepseek-chat",
      createdAt: new Date(),
    });
    mockSetActiveSnapshot.mockResolvedValueOnce(undefined);
    mockUpdateSessionTokenCount.mockResolvedValueOnce(undefined);
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await autoCompactIfNeeded(
      "sess-1",
      "deepseek-chat",
      "deepseek",
      { inputTokens: 55_000, outputTokens: 10_000 }, // 65K total > 90% of 65536
    );

    expect(result).not.toBeNull();
    expect(result!.compactionMessage.role).toBe("compaction");
    expect(result!.newTokenUsage).toBeDefined();
  });

  it("uses total tokens (input + output) for threshold check", async () => {
    // Mock threshold to 90%
    mockGetRuntimeSetting.mockResolvedValueOnce("90");

    // deepseek-chat: 65536 context
    // 90% threshold = 58982 tokens
    // Input alone: 50000 (76%) - below threshold
    // Total: 50000 + 10000 = 60000 (92%) - above threshold
    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
    ];
    mockGetRuntimeSetting.mockResolvedValueOnce("40"); // for compaction verbatim budget
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "Summary",
      toolCalls: [],
    });
    mockCreateSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      sessionId: "sess-1",
      summary: "Summary",
      summaryTokenCount: 5,
      verbatimMessageIds: ["msg-2", "msg-3"],
      verbatimTokenCount: 5,
      totalTokenCount: 10,
      triggerTokenCount: 0,
      modelUsed: "deepseek-chat",
      createdAt: new Date(),
    });
    mockSetActiveSnapshot.mockResolvedValueOnce(undefined);
    mockUpdateSessionTokenCount.mockResolvedValueOnce(undefined);
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await autoCompactIfNeeded(
      "sess-1",
      "deepseek-chat",
      "deepseek",
      { inputTokens: 50_000, outputTokens: 10_000 },
    );

    // Should trigger because 60000 > 58982 (90% of 65536)
    expect(result).not.toBeNull();
  });

  it("returns null for unknown model", async () => {
    // Mock threshold (won't matter since model not found)
    mockGetRuntimeSetting.mockResolvedValueOnce("90");

    const result = await autoCompactIfNeeded(
      "sess-1",
      "unknown-model",
      "unknown",
      { inputTokens: 100_000, outputTokens: 50_000 },
    );

    expect(result).toBeNull();
  });

  it("respects custom threshold from runtime settings", async () => {
    // Set threshold to 50%
    mockGetRuntimeSetting.mockResolvedValueOnce("50");

    // deepseek-chat: 65536 context
    // 50% = 32768 tokens
    // Usage: 40000 total > 32768
    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
    ];
    mockGetRuntimeSetting.mockResolvedValueOnce("40"); // for compaction verbatim budget
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "Summary",
      toolCalls: [],
    });
    mockCreateSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      sessionId: "sess-1",
      summary: "Summary",
      summaryTokenCount: 5,
      verbatimMessageIds: ["msg-2", "msg-3"],
      verbatimTokenCount: 5,
      totalTokenCount: 10,
      triggerTokenCount: 0,
      modelUsed: "deepseek-chat",
      createdAt: new Date(),
    });
    mockSetActiveSnapshot.mockResolvedValueOnce(undefined);
    mockUpdateSessionTokenCount.mockResolvedValueOnce(undefined);
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await autoCompactIfNeeded(
      "sess-1",
      "deepseek-chat",
      "deepseek",
      { inputTokens: 30_000, outputTokens: 10_000 },
    );

    expect(result).not.toBeNull();
  });

  it("returns null when compaction fails", async () => {
    // Mock threshold to trigger compaction
    mockGetRuntimeSetting.mockResolvedValueOnce("90");
    mockGetRuntimeSetting.mockResolvedValueOnce("40"); // for compaction verbatim budget

    // Set up to trigger compaction but fail
    mockGetSession.mockResolvedValueOnce(null); // Will cause "Session not found"

    const result = await autoCompactIfNeeded(
      "sess-1",
      "deepseek-chat",
      "deepseek",
      { inputTokens: 60_000, outputTokens: 5_000 },
    );

    // Should return null on error, not throw
    expect(result).toBeNull();
  });
});
