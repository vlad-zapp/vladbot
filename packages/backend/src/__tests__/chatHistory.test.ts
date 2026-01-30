import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../services/db.js", () => ({
  default: { query: mockQuery },
}));

vi.mock("../services/sessionFiles.js", () => ({
  deleteSessionFiles: vi.fn(),
}));

const { chatHistoryTool } = await import("../services/tools/chatHistory.js");

const exec = (args: Record<string, unknown>, sessionId?: string) =>
  chatHistoryTool.execute(args, sessionId);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chatHistoryTool definition", () => {
  it("has correct name and operations", () => {
    expect(chatHistoryTool.definition.name).toBe("chat_history");
    expect(Object.keys(chatHistoryTool.definition.operations)).toEqual([
      "search_current",
      "search_all",
    ]);
  });

  it("search_current requires query", () => {
    const op = chatHistoryTool.definition.operations.search_current;
    expect(op.required).toContain("query");
  });

  it("search_all requires query", () => {
    const op = chatHistoryTool.definition.operations.search_all;
    expect(op.required).toContain("query");
  });
});

describe("search_current", () => {
  it("returns error when no sessionId", async () => {
    const result = await exec({ operation: "search_current", query: "test" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("No active session.");
  });

  it("returns error when query is missing", async () => {
    const result = await exec(
      { operation: "search_current", query: "" },
      "sess-1",
    );
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("query is required.");
  });

  it("returns matching messages", async () => {
    // Count query
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 2 }] });
    // Data query
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "m1",
          session_id: "sess-1",
          role: "user",
          content: "Hello world",
          images: null,
          model: null,
          tool_calls: null,
          tool_results: null,
          approval_status: null,
          timestamp: 1000,
          rank: 0.5,
        },
        {
          id: "m2",
          session_id: "sess-1",
          role: "assistant",
          content: "Hi there",
          images: null,
          model: "gpt-4",
          tool_calls: null,
          tool_results: null,
          approval_status: null,
          timestamp: 2000,
          rank: 0.3,
        },
      ],
    });

    const result = await exec(
      { operation: "search_current", query: "hello" },
      "sess-1",
    );
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(2);
    expect(parsed.total).toBe(2);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[0].content).toBe("Hello world");
    expect(parsed.messages[0].time).toBeDefined();
    expect(parsed.messages[0].session_title).toBeUndefined();
  });

  it("uses websearch_to_tsquery in SQL", async () => {
    // Return 1 result so trigram fallback is not triggered
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1", session_id: "sess-1", role: "user", content: "docker",
        images: null, model: null, tool_calls: null, tool_results: null,
        approval_status: null, timestamp: 1000, rank: 0.5,
      }],
    });

    await exec(
      { operation: "search_current", query: "docker" },
      "sess-1",
    );

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const countSql = mockQuery.mock.calls[0][0];
    const dataSql = mockQuery.mock.calls[1][0];
    expect(countSql).toContain("websearch_to_tsquery");
    expect(dataSql).toContain("websearch_to_tsquery");
    expect(dataSql).toContain("session_id = $1");
  });

  it("filters by role when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1", session_id: "sess-1", role: "user", content: "x",
        images: null, model: null, tool_calls: null, tool_results: null,
        approval_status: null, timestamp: 1000, rank: 0.5,
      }],
    });

    await exec(
      { operation: "search_current", query: "test", role: "user" },
      "sess-1",
    );

    const countSql = mockQuery.mock.calls[0][0];
    expect(countSql).toContain("role = $3");
  });

  it("truncates long content", async () => {
    const longContent = "A".repeat(5000);
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "m1",
          session_id: "sess-1",
          role: "user",
          content: longContent,
          images: null,
          model: null,
          tool_calls: null,
          tool_results: null,
          approval_status: null,
          timestamp: 1000,
          rank: 0.5,
        },
      ],
    });

    const result = await exec(
      { operation: "search_current", query: "test" },
      "sess-1",
    );
    const parsed = JSON.parse(result);

    expect(parsed.messages[0].content.length).toBeLessThan(longContent.length);
    expect(parsed.messages[0].content).toContain("[truncated]");
  });

  it("returns empty results gracefully", async () => {
    // FTS returns 0, then trigram fallback also returns 0
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await exec(
      { operation: "search_current", query: "nonexistent" },
      "sess-1",
    );
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(0);
    expect(parsed.total).toBe(0);
    expect(parsed.messages).toEqual([]);
  });
});

describe("search_all", () => {
  it("returns error when query is missing", async () => {
    const result = await exec({ operation: "search_all", query: "" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("query is required.");
  });

  it("returns matching messages with session_title", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "m1",
          session_id: "sess-2",
          role: "user",
          content: "Docker setup notes",
          images: null,
          model: null,
          tool_calls: null,
          tool_results: null,
          approval_status: null,
          timestamp: 3000,
          session_title: "Docker project",
          rank: 0.8,
        },
      ],
    });

    const result = await exec(
      { operation: "search_all", query: "docker" },
      "sess-1",
    );
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(1);
    expect(parsed.messages[0].content).toBe("Docker setup notes");
    expect(parsed.messages[0].session_title).toBe("Docker project");
  });

  it("excludes current session", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1", session_id: "sess-2", role: "user", content: "x",
        images: null, model: null, tool_calls: null, tool_results: null,
        approval_status: null, timestamp: 1000, session_title: "Other", rank: 0.5,
      }],
    });

    await exec(
      { operation: "search_all", query: "test" },
      "sess-1",
    );

    const countSql = mockQuery.mock.calls[0][0];
    const countParams = mockQuery.mock.calls[0][1];
    expect(countSql).toContain("session_id != $2");
    expect(countParams).toContain("sess-1");
  });

  it("works without sessionId (no exclusion)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1", session_id: "sess-1", role: "user", content: "x",
        images: null, model: null, tool_calls: null, tool_results: null,
        approval_status: null, timestamp: 1000, session_title: "Chat", rank: 0.5,
      }],
    });

    await exec({ operation: "search_all", query: "test" });

    const countSql = mockQuery.mock.calls[0][0];
    expect(countSql).not.toContain("session_id !=");
  });

  it("joins sessions table for title", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1", session_id: "sess-1", role: "user", content: "x",
        images: null, model: null, tool_calls: null, tool_results: null,
        approval_status: null, timestamp: 1000, session_title: "Chat", rank: 0.5,
      }],
    });

    await exec({ operation: "search_all", query: "test" });

    const dataSql = mockQuery.mock.calls[1][0];
    expect(dataSql).toContain("JOIN sessions");
    expect(dataSql).toContain("session_title");
  });
});

describe("unknown operation", () => {
  it("throws", async () => {
    await expect(
      exec({ operation: "bad_op", query: "test" }, "sess-1"),
    ).rejects.toThrow("Unknown chat_history operation: bad_op");
  });
});
