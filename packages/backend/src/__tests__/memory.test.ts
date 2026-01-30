import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../services/db.js", () => ({
  default: { query: mockQuery },
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

vi.mock("../config/env.js", () => ({
  env: {
    MEMORY_MAX_STORAGE_TOKENS: 1000,
    MEMORY_MAX_RETURN_TOKENS: 500,
  },
}));

const { memoryTool } = await import("../services/tools/memory.js");

const exec = (args: Record<string, unknown>) => memoryTool.execute(args);

beforeEach(() => {
  mockQuery.mockReset();
});

describe("memory tool definition", () => {
  it("has correct name and operations", () => {
    const def = memoryTool.definition;
    expect(def.name).toBe("memory");
    expect(def.operations.save).toBeDefined();
    expect(def.operations.search).toBeDefined();
    expect(def.operations.list).toBeDefined();
    expect(def.operations.delete).toBeDefined();
    expect(def.operations.update).toBeDefined();
  });

  it("has correct parameters per operation", () => {
    const ops = memoryTool.definition.operations;
    expect(ops.save.params.header).toBeDefined();
    expect(ops.save.params.text).toBeDefined();
    expect(ops.save.params.tags).toBeDefined();
    expect(ops.save.required).toContain("header");
    expect(ops.save.required).toContain("text");
    expect(ops.search.params.query).toBeDefined();
    expect(ops.search.params.date_from).toBeDefined();
    expect(ops.search.params.date_to).toBeDefined();
    expect(ops.list.params.limit).toBeDefined();
    expect(ops.list.params.offset).toBeDefined();
    expect(ops.list.params.order).toBeDefined();
    expect(ops.delete.params.id).toBeDefined();
    expect(ops.delete.required).toContain("id");
    expect(ops.update.params.id).toBeDefined();
    expect(ops.update.required).toContain("id");
  });
});

describe("save operation", () => {
  it("saves memory and returns JSON with id and stats", async () => {
    const now = new Date().toISOString();
    // createMemory: SUM query
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 100 }] });
    // createMemory: INSERT RETURNING *
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "mem-1", header: "Test Header", body: "Test body content", tags: ["tag1", "tag2"], session_id: null, token_count: 8, created_at: now, updated_at: now }],
    });
    // getMemoryStats: SELECT COUNT/SUM
    mockQuery.mockResolvedValueOnce({ rows: [{ total_memories: 1, total_tokens: 108 }] });

    const result = JSON.parse(await exec({
      operation: "save",
      header: "Test Header",
      text: "Test body content",
      tags: ["tag1", "tag2"],
    }));

    expect(result.status).toBe("saved");
    expect(result.id).toBe("mem-1");
    expect(result.header).toBe("Test Header");
    expect(result.tags).toEqual(["tag1", "tag2"]);
    expect(result.token_count).toBeGreaterThan(0);
    expect(result.storage_used).toBeGreaterThan(100);
    expect(result.storage_limit).toBe(1000);
  });

  it("rejects when storage limit exceeded", async () => {
    // createMemory: SUM returns near-limit value
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 999 }] });

    const result = JSON.parse(await exec({
      operation: "save",
      header: "Big header",
      text: "Some body text that will push over the limit",
    }));

    expect(result.status).toBe("error");
    expect(result.message).toContain("storage limit");
    // Should NOT have called INSERT (only the SUM query)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("handles session_id", async () => {
    const now = new Date().toISOString();
    // createMemory: SUM query
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    // createMemory: INSERT RETURNING *
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "mem-2", header: "Scoped", body: "Body", tags: [], session_id: "session-abc", token_count: 3, created_at: now, updated_at: now }],
    });
    // getMemoryStats: SELECT COUNT/SUM
    mockQuery.mockResolvedValueOnce({ rows: [{ total_memories: 1, total_tokens: 3 }] });

    await exec({
      operation: "save",
      header: "Scoped",
      text: "Body",
      session_id: "session-abc",
    });

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[1]).toContain("session-abc");
  });

  it("requires header", async () => {
    await expect(exec({
      operation: "save",
      text: "body without header",
    })).rejects.toThrow("Missing required argument: header");
  });

  it("requires text", async () => {
    await expect(exec({
      operation: "save",
      header: "header without body",
    })).rejects.toThrow("Missing required argument: text");
  });
});

describe("search operation", () => {
  it("performs full-text search", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "mem-1",
        header: "Found",
        body: "Match content",
        tags: ["t1"],
        session_id: null,
        token_count: 10,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      }],
    });

    const result = JSON.parse(await exec({
      operation: "search",
      query: "Match content",
    }));

    expect(result.count).toBe(1);
    expect(result.memories[0].id).toBe("mem-1");
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("websearch_to_tsquery");
    expect(sql).toContain("ts_rank");
  });

  it("filters by tags", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await exec({
      operation: "search",
      tags: ["important", "project"],
    });

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("tags @>");
  });

  it("filters by date range", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await exec({
      operation: "search",
      date_from: "2025-01-01",
      date_to: "2025-12-31",
    });

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("created_at >=");
    expect(sql).toContain("created_at <=");
  });

  it("filters by session scope (includes global)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await exec({
      operation: "search",
      session_id: "s1",
    });

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("session_id =");
    expect(sql).toContain("OR session_id IS NULL");
  });

  it("paginates with limit and offset", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await exec({
      operation: "search",
      limit: 5,
      offset: 10,
    });

    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain(5);
    expect(params).toContain(10);
  });

  it("truncates results when token limit exceeded", async () => {
    // Each memory has 300 tokens, MEMORY_MAX_RETURN_TOKENS is 500
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "m1", header: "H1", body: "B1", tags: [], session_id: null, token_count: 300, created_at: "2025-01-01", updated_at: "2025-01-01" },
        { id: "m2", header: "H2", body: "B2", tags: [], session_id: null, token_count: 300, created_at: "2025-01-02", updated_at: "2025-01-02" },
      ],
    });

    const result = JSON.parse(await exec({
      operation: "search",
      query: "test",
    }));

    expect(result.truncated).toBe(true);
    expect(result.message).toContain("truncated");
    expect(result.count).toBe(1); // Only first fits within 500 token limit
  });

  it("handles empty results", async () => {
    // FTS returns empty, then trigram fallback also returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = JSON.parse(await exec({
      operation: "search",
      query: "nothing",
    }));

    expect(result.count).toBe(0);
    expect(result.memories).toEqual([]);
  });

  it("clamps limit to max 100", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await exec({ operation: "search", limit: 999 });

    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain(100);
  });
});

describe("list operation", () => {
  it("lists memories with total count", async () => {
    // searchMemories: SELECT with body
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1",
        header: "Listed",
        body: "Body text",
        tags: ["t1"],
        session_id: null,
        token_count: 10,
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
      }],
    });
    // listMemories: COUNT query
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 42 }] });
    // listMemories: SELECT list
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1",
        header: "Listed",
        tags: ["t1"],
        session_id: null,
        token_count: 10,
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
      }],
    });

    const result = JSON.parse(await exec({ operation: "list" }));

    expect(result.total).toBe(42);
    expect(result.count).toBe(1);
    expect(result.memories[0].header).toBe("Listed");
  });

  it("supports order newest/oldest", async () => {
    // searchMemories
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // listMemories: COUNT
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    // listMemories: SELECT
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await exec({ operation: "list", order: "oldest" });

    // listMemories SELECT is the 3rd call (index 2)
    const sql = mockQuery.mock.calls[2][0];
    expect(sql).toContain("ASC");
  });

  it("defaults to newest order", async () => {
    // searchMemories
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // listMemories: COUNT
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    // listMemories: SELECT
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await exec({ operation: "list" });

    const sql = mockQuery.mock.calls[2][0];
    expect(sql).toContain("DESC");
  });

  it("filters by tags", async () => {
    // searchMemories
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // listMemories: COUNT
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    // listMemories: SELECT
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await exec({ operation: "list", tags: ["work"] });

    // searchMemories query is the first call
    const searchSql = mockQuery.mock.calls[0][0];
    expect(searchSql).toContain("tags @>");
  });
});

describe("delete operation", () => {
  it("deletes memory by id", async () => {
    // getMemory: SELECT *
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "mem-1", header: "Deleted", body: "Body", tags: [], session_id: null, token_count: 5, created_at: "2025-01-01", updated_at: "2025-01-01" }],
    });
    // deleteMemory: DELETE RETURNING id
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "mem-1" }] });

    const result = JSON.parse(await exec({ operation: "delete", id: "mem-1" }));
    expect(result.status).toBe("deleted");
    expect(result.id).toBe("mem-1");
    expect(result.header).toBe("Deleted");
  });

  it("returns error for non-existent id", async () => {
    // getMemory: returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = JSON.parse(await exec({ operation: "delete", id: "nonexistent" }));
    expect(result.status).toBe("error");
    expect(result.message).toContain("not found");
  });

  it("requires id", async () => {
    await expect(exec({ operation: "delete" })).rejects.toThrow("Missing required argument: id");
  });
});

describe("update operation", () => {
  it("updates header and text", async () => {
    // Fetch current (token_count must be < new count so SUM query triggers)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        header: "Old Header",
        body: "Old Body",
        tags: ["t1"],
        token_count: 2,
      }],
    });
    // SUM query (token count increased: new ~8 > old 2)
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 50 }] });
    // UPDATE query
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "mem-1",
        header: "New Header",
        tags: ["t1"],
        token_count: 12,
        created_at: "2025-01-01",
        updated_at: "2025-01-02",
      }],
    });

    const result = JSON.parse(await exec({
      operation: "update",
      id: "mem-1",
      header: "New Header",
      text: "New Body Content",
    }));

    expect(result.status).toBe("updated");
    expect(result.header).toBe("New Header");
  });

  it("returns error for non-existent id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = JSON.parse(await exec({
      operation: "update",
      id: "nonexistent",
      header: "X",
    }));

    expect(result.status).toBe("error");
    expect(result.message).toContain("not found");
  });

  it("returns error when no fields provided", async () => {
    const result = JSON.parse(await exec({ operation: "update", id: "mem-1" }));
    expect(result.status).toBe("error");
    expect(result.message).toContain("No fields");
  });

  it("rejects when update would exceed storage limit", async () => {
    // Fetch current (small)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        header: "S",
        body: "S",
        tags: [],
        token_count: 1,
      }],
    });
    // SUM returns near-limit
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 999 }] });

    const result = JSON.parse(await exec({
      operation: "update",
      id: "mem-1",
      text: "A much larger body that will exceed the storage limit when added to the existing total",
    }));

    expect(result.status).toBe("error");
    expect(result.message).toContain("storage limit");
  });

  it("updates tags only (no token change)", async () => {
    // Fetch current
    mockQuery.mockResolvedValueOnce({
      rows: [{
        header: "H",
        body: "B",
        tags: ["old"],
        token_count: 2,
      }],
    });
    // countTokens("H B") = ceil(3/4) = 1, which is <= 2 (old count), so no SUM query
    // UPDATE query
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "mem-1",
        header: "H",
        tags: ["new1", "new2"],
        token_count: 1,
        created_at: "2025-01-01",
        updated_at: "2025-01-02",
      }],
    });

    const result = JSON.parse(await exec({
      operation: "update",
      id: "mem-1",
      tags: ["new1", "new2"],
    }));

    expect(result.status).toBe("updated");
    // Should have been 2 queries: SELECT + UPDATE (no SUM since tokens didn't increase)
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

describe("unknown operation", () => {
  it("throws for unknown operation", async () => {
    await expect(exec({ operation: "bogus" })).rejects.toThrow("Unknown memory operation");
  });
});
