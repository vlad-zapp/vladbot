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
vi.mock("../services/tokenCounter.js", () => ({
  countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  estimateMessageTokens: vi.fn((msg: { content: string; toolCalls?: unknown[]; toolResults?: unknown[] }) => {
    let text = msg.content;
    if (msg.toolCalls) text += JSON.stringify(msg.toolCalls);
    if (msg.toolResults) text += JSON.stringify(msg.toolResults);
    return Math.ceil(text.length / 4);
  }),
}));

const { compactSession, calculateVerbatimCount } =
  await import("../services/compaction.js");
const { estimateMessageTokens } = await import("../services/tokenCounter.js");

beforeEach(() => {
  vi.clearAllMocks();
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

describe("calculateVerbatimCount", () => {
  it("uses token budget to determine tail size", () => {
    // 6 short messages, huge context → all fit, but min 2 for summary
    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
      makeMsg({ role: "user", content: "E" }, 4),
      makeMsg({ role: "assistant", content: "F" }, 5),
    ];
    const count = calculateVerbatimCount(messages, 200_000);
    // Budget is huge, all messages tiny, but must keep 2 for summary
    expect(count).toBe(4);
  });

  it("limits tail when budget is small", () => {
    // Each message ~1 token. Budget = floor(20 * 0.4) = 8 tokens.
    // 10 messages, each ~1 token. Can fit 8 in tail.
    // But must keep 2 for summary, so max tail = 8.
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ role: i % 2 === 0 ? "user" : "assistant", content: "X" }, i),
    );
    const count = calculateVerbatimCount(messages, 20);
    // Budget = 8 tokens, each message 1 token, max from length = 8
    expect(count).toBe(8);
  });

  it("stops at budget even with many messages", () => {
    // Messages with ~25 chars each → ~7 tokens each
    // Budget = floor(50 * 0.4) = 20 tokens → fits ~2 messages
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "A medium length message.",
      }, i),
    );
    const count = calculateVerbatimCount(messages, 50);
    // Each message ~7 tokens (25 chars / 4), budget 20 → fits 2, then 3rd would exceed
    // But min 2 is guaranteed
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThan(10 - 2); // Must leave at least 2 for summary
  });

  it("guarantees at least 2 messages in tail", () => {
    // Very small budget, 4 messages
    const messages = [
      makeMsg({ role: "user", content: "A really long message that uses many tokens ".repeat(10) }, 0),
      makeMsg({ role: "assistant", content: "Another long message ".repeat(10) }, 1),
      makeMsg({ role: "user", content: "Short" }, 2),
      makeMsg({ role: "assistant", content: "Short" }, 3),
    ];
    // Budget = floor(1 * 0.4) = 0 tokens, but min 2 is enforced
    const count = calculateVerbatimCount(messages, 1);
    expect(count).toBe(2);
  });

  it("falls back to VERBATIM_TAIL_COUNT when contextWindow is 0", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ role: i % 2 === 0 ? "user" : "assistant", content: "X" }, i),
    );
    const count = calculateVerbatimCount(messages, 0);
    // VERBATIM_TAIL_COUNT = 5, messages.length - 2 = 8, so min(5, 8) = 5
    expect(count).toBe(5);
  });

  it("returns 0 when budgetPercent is 0", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ role: i % 2 === 0 ? "user" : "assistant", content: "X" }, i),
    );
    const count = calculateVerbatimCount(messages, 200_000, 0);
    expect(count).toBe(0);
  });

  it("respects custom budgetPercent", () => {
    // 10 messages, each ~1 token.
    // With 10% of 100 = 10 token budget → fits all 8 (10-2)
    // With 10% of 20 = 2 token budget → fits 2
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ role: i % 2 === 0 ? "user" : "assistant", content: "X" }, i),
    );
    const count10pct = calculateVerbatimCount(messages, 100, 10);
    // Budget = floor(100 * 0.1) = 10 tokens, each msg 1 token → fits 8 (limited by length-2)
    expect(count10pct).toBe(8);
  });

  it("clamps budgetPercent to 50% max", () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      makeMsg({ role: i % 2 === 0 ? "user" : "assistant", content: "X" }, i),
    );
    // Pass 80% but should be clamped to 50%
    // Budget at 50% of 10 = 5 tokens, each msg 1 token → fits 4 (6-2)
    const count = calculateVerbatimCount(messages, 10, 80);
    expect(count).toBe(4);
  });
});

describe("compactSession", () => {
  it("throws when session is not found", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    await expect(
      compactSession("nonexistent", "model-1", "anthropic", 100_000),
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
      compactSession("sess-1", "model-1", "anthropic", 100_000),
    ).rejects.toThrow("Not enough messages to compact");
  });

  it("summarizes all messages except the verbatim tail", async () => {
    // 6 short messages, large context → tail = 4 (min 2 for summary)
    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
      makeMsg({ role: "user", content: "E" }, 4),
      makeMsg({ role: "assistant", content: "F" }, 5),
    ];
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "Summary of A and B",
      toolCalls: [],
    });
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await compactSession("sess-1", "model-1", "anthropic", 100_000);

    expect(mockGenerateResponse).toHaveBeenCalledTimes(1);
    const summaryInput = mockGenerateResponse.mock.calls[0][0][0].content;
    expect(summaryInput).toContain("User: A");
    expect(summaryInput).toContain("Assistant: B");
    // The tail (C, D, E, F) should NOT be in the summary
    expect(summaryInput).not.toContain("User: C");
    expect(summaryInput).not.toContain("Assistant: D");

    expect(result.summary).toBe("Summary of A and B");
    expect(result.compactionMessage.role).toBe("compaction");
  });

  it("with 4 messages, summarizes first 2 and keeps last 2 as tail", async () => {
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
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await compactSession("sess-1", "model-1", "anthropic", 100_000);

    const summaryInput = mockGenerateResponse.mock.calls[0][0][0].content;
    expect(summaryInput).toContain("User: A");
    expect(summaryInput).toContain("Assistant: B");
    expect(summaryInput).not.toContain("User: C");

    expect(result.summary).toBe("Summary of A and B");
  });

  it("sets compaction timestamp to current time", async () => {
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
    mockAddMessage.mockResolvedValueOnce(undefined);

    const before = Date.now();
    const result = await compactSession("sess-1", "model-1", "anthropic", 100_000);
    const after = Date.now();

    expect(result.compactionMessage.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.compactionMessage.timestamp).toBeLessThanOrEqual(after);
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
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await compactSession("sess-1", "model-1", "anthropic", 100_000);

    expect(result.compactionMessage.verbatimCount).toBe(2);
    // Also verify it's passed to addMessage
    const savedMsg = mockAddMessage.mock.calls[0][1] as ChatMessage;
    expect(savedMsg.verbatimCount).toBe(2);
  });

  it("does NOT delete old messages from the database", async () => {
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
    mockAddMessage.mockResolvedValueOnce(undefined);

    await compactSession("sess-1", "model-1", "anthropic", 100_000);

    // Only addMessage should be called, not deleteMessages
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
  });

  it("includes tool calls and tool results in the summary text", async () => {
    const messages = [
      makeMsg({ role: "user", content: "Find files" }, 0),
      makeMsg(
        {
          role: "assistant",
          content: "Let me check",
          toolCalls: [{ id: "tc1", name: "filesystem", arguments: { path: "/tmp" } }],
        },
        1,
      ),
      makeMsg(
        {
          role: "tool",
          content: "",
          toolResults: [{ toolCallId: "tc1", output: "file1.txt\nfile2.txt" }],
        },
        2,
      ),
      makeMsg({ role: "user", content: "T1" }, 3),
      makeMsg({ role: "assistant", content: "T2" }, 4),
      makeMsg({ role: "user", content: "T3" }, 5),
      makeMsg({ role: "assistant", content: "T4" }, 6),
      makeMsg({ role: "user", content: "T5" }, 7),
    ];
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "Summary with tools",
      toolCalls: [],
    });
    mockAddMessage.mockResolvedValueOnce(undefined);

    // Use small context window so tool messages end up in summarized set.
    // Messages 3-7 are ~1 token each = 5 tokens.
    // Message 2 (tool result) has serialized JSON ~50 chars = ~13 tokens.
    // Budget = floor(25 * 0.4) = 10. Fits 5 short messages but not the tool message.
    await compactSession("sess-1", "model-1", "anthropic", 25);

    const summaryInput = mockGenerateResponse.mock.calls[0][0][0].content;
    expect(summaryInput).toContain("Tool call: filesystem");
    expect(summaryInput).toContain("Tool result:");
    expect(summaryInput).toContain("file1.txt");
  });

  it("includes previous compaction messages in summary text", async () => {
    const messages = [
      makeMsg({ role: "compaction", content: "Earlier summary" }, 0),
      makeMsg({ role: "user", content: "A" }, 1),
      makeMsg({ role: "assistant", content: "B" }, 2),
      makeMsg({ role: "user", content: "C" }, 3),
      makeMsg({ role: "assistant", content: "D" }, 4),
      makeMsg({ role: "user", content: "E" }, 5),
      makeMsg({ role: "assistant", content: "F" }, 6),
    ];
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "Combined summary",
      toolCalls: [],
    });
    mockAddMessage.mockResolvedValueOnce(undefined);

    // Use small context window so more messages go to summary.
    // Short messages ~1 token each. Budget = floor(15 * 0.4) = 6.
    // Messages 1-6 are ~1 token each. Budget fits 6, but min 2 for summary → tail = 5.
    // So summarized set = messages 0-1 (compaction + user "A").
    await compactSession("sess-1", "model-1", "anthropic", 15);

    const summaryInput = mockGenerateResponse.mock.calls[0][0][0].content;
    expect(summaryInput).toContain("[Previous summary]");
    expect(summaryInput).toContain("Earlier summary");
  });

  it("adjusts tail size based on context window", async () => {
    // 10 messages with ~7 tokens each (25 chars / 4)
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "A medium length message.",
      }, i),
    );
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({
      text: "Summary",
      toolCalls: [],
    });
    mockAddMessage.mockResolvedValueOnce(undefined);

    // Small context: budget = floor(50 * 0.4) = 20 tokens
    // Each message ~7 tokens → fits 2 messages (14 tokens), 3rd would be 21 > 20
    // But min 2 guaranteed
    await compactSession("sess-1", "model-1", "anthropic", 50);

    const savedMsg = mockAddMessage.mock.calls[0][1] as ChatMessage;
    expect(savedMsg.verbatimCount).toBeGreaterThanOrEqual(2);
    expect(savedMsg.verbatimCount).toBeLessThan(8); // Must leave 2 for summary
  });

  it("reads compaction_verbatim_budget from runtime settings", async () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ role: i % 2 === 0 ? "user" : "assistant", content: "X" }, i),
    );
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({ text: "Summary", toolCalls: [] });
    mockAddMessage.mockResolvedValueOnce(undefined);

    await compactSession("sess-1", "model-1", "anthropic", 100_000);

    expect(mockGetRuntimeSetting).toHaveBeenCalledWith("compaction_verbatim_budget");
  });

  it("with budget 0% summarizes all messages", async () => {
    mockGetRuntimeSetting.mockResolvedValueOnce("0");

    const messages = [
      makeMsg({ role: "user", content: "A" }, 0),
      makeMsg({ role: "assistant", content: "B" }, 1),
      makeMsg({ role: "user", content: "C" }, 2),
      makeMsg({ role: "assistant", content: "D" }, 3),
    ];
    mockGetSession.mockResolvedValueOnce(makeSession(messages));
    mockGenerateResponse.mockResolvedValueOnce({ text: "Full summary", toolCalls: [] });
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await compactSession("sess-1", "model-1", "anthropic", 100_000);

    // With 0% budget, verbatimCount should be 0 and ALL messages should be summarized
    expect(result.compactionMessage.verbatimCount).toBe(0);
    const summaryInput = mockGenerateResponse.mock.calls[0][0][0].content;
    expect(summaryInput).toContain("User: A");
    expect(summaryInput).toContain("Assistant: D");
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
    mockAddMessage.mockResolvedValueOnce(undefined);

    const result = await compactSession("sess-1", "model-1", "anthropic", 100_000);

    expect(result.compactionMessage.rawTokenCount).toBe(42);
    expect(result.compactionMessage.tokenCount).toBeGreaterThan(0);
  });
});
