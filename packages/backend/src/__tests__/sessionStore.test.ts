import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../services/db.js", () => ({
  default: { query: mockQuery },
}));

vi.mock("../services/sessionFiles.js", () => ({
  deleteSessionFiles: vi.fn(),
}));

const {
  createSession,
  listSessions,
  getSession,
  updateSessionTitle,
  updateSession,
  getSessionAutoApprove,
  deleteSession,
  addMessage,
  updateMessage,
  atomicApprove,
  searchSessionMessages,
  searchAllMessages,
} = await import("../services/sessionStore.js");

const { deleteSessionFiles } = await import("../services/sessionFiles.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSession", () => {
  it("inserts and returns a Session with camelCase fields", async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "abc-123",
        title: "New chat",
        auto_approve: false,
        created_at: now,
        updated_at: now,
      }],
    });

    const session = await createSession();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO sessions");
    expect(sql).toContain("RETURNING");
    expect(params).toHaveLength(2);
    expect(params[1]).toBe("New chat");

    expect(session.id).toBe("abc-123");
    expect(session.title).toBe("New chat");
    expect(session.createdAt).toBe(now.toISOString());
    expect(session.updatedAt).toBe(now.toISOString());
  });

  it("uses custom title", async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "abc-456",
        title: "My Title",
        auto_approve: false,
        created_at: now,
        updated_at: now,
      }],
    });

    const session = await createSession("My Title");
    const params = mockQuery.mock.calls[0][1];
    expect(params[1]).toBe("My Title");
    expect(session.title).toBe("My Title");
  });
});

describe("listSessions", () => {
  it("returns array of sessions", async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "s1", title: "First", auto_approve: false, created_at: now, updated_at: now },
        { id: "s2", title: "Second", auto_approve: false, created_at: now, updated_at: now },
      ],
    });

    const sessions = await listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe("s1");
    expect(sessions[1].id).toBe("s2");
  });
});

describe("getSession", () => {
  it("returns SessionWithMessages for existing session", async () => {
    const now = new Date();
    // Session query
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "s1", title: "Chat", auto_approve: false, created_at: now, updated_at: now }],
    });
    // Messages query
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "m1",
          session_id: "s1",
          role: "user",
          content: "Hello",
          model: null,
          tool_calls: null,
          tool_results: null,
          approval_status: null,
          timestamp: 1000,
        },
      ],
    });

    const result = await getSession("s1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("s1");
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0].content).toBe("Hello");
    expect(result!.messages[0].role).toBe("user");
  });

  it("returns null for missing session", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getSession("nonexistent");
    expect(result).toBeNull();
  });

  it("parses JSONB toolCalls from messages", async () => {
    const now = new Date();
    const toolCalls = [{ id: "tc1", name: "filesystem", arguments: { op: "list" } }];
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "s1", title: "Chat", auto_approve: false, created_at: now, updated_at: now }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1",
        session_id: "s1",
        role: "assistant",
        content: "",
        model: "gpt-4",
        tool_calls: toolCalls, // JSONB comes pre-parsed from pg
        tool_results: null,
        approval_status: null,
        timestamp: 2000,
      }],
    });

    const result = await getSession("s1");
    expect(result!.messages[0].toolCalls).toEqual(toolCalls);
  });
});

describe("updateSessionTitle", () => {
  it("returns updated session", async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "s1", title: "New Title", auto_approve: false, created_at: now, updated_at: now }],
    });

    const session = await updateSessionTitle("s1", "New Title");
    expect(session).not.toBeNull();
    expect(session!.title).toBe("New Title");
  });

  it("returns null for missing session", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await updateSessionTitle("nonexistent", "Title");
    expect(result).toBeNull();
  });
});

describe("deleteSession", () => {
  it("returns true and calls deleteSessionFiles", async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: "s1" }],
    });

    const result = await deleteSession("s1");
    expect(result).toBe(true);
    expect(deleteSessionFiles).toHaveBeenCalledWith("s1");
  });

  it("returns false for missing session", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const result = await deleteSession("nonexistent");
    expect(result).toBe(false);
  });
});

describe("addMessage", () => {
  it("inserts message and touches session, returns id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "m1" }] });
    mockQuery.mockResolvedValueOnce({});

    const id = await addMessage("s1", {
      id: "m1",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    });

    expect(id).toBe("m1");
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain("INSERT INTO messages");
    expect(insertCall[0]).toContain("RETURNING id");
    expect(insertCall[0]).toContain("COALESCE");
    const touchCall = mockQuery.mock.calls[1];
    expect(touchCall[0]).toContain("UPDATE sessions");
  });

  it("passes null id when message has no id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "db-generated-uuid" }] });
    mockQuery.mockResolvedValueOnce({});

    const id = await addMessage("s1", {
      id: "",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    });

    expect(id).toBe("db-generated-uuid");
    const params = mockQuery.mock.calls[0][1];
    expect(params[0]).toBeNull(); // empty string becomes null via || null
  });
});

describe("updateMessage", () => {
  it("merges partial updates", async () => {
    // Current message
    mockQuery.mockResolvedValueOnce({
      rows: [{
        content: "original",
        tool_calls: null,
        tool_results: null,
        approval_status: null,
      }],
    });
    // Update
    mockQuery.mockResolvedValueOnce({});

    await updateMessage("m1", { content: "updated" });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain("UPDATE messages");
    expect(updateCall[1][0]).toBe("updated"); // new content
  });

  it("no-ops for missing message", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await updateMessage("nonexistent", { content: "x" });
    expect(mockQuery).toHaveBeenCalledTimes(1); // only the SELECT, no UPDATE
  });
});

describe("searchSessionMessages", () => {
  it("uses full-text search with session filter", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "m1",
          session_id: "s1",
          role: "user",
          content: "Hello",
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

    const result = await searchSessionMessages({
      sessionId: "s1",
      query: "hello",
    });

    expect(result.total).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("Hello");

    const countSql = mockQuery.mock.calls[0][0];
    const dataSql = mockQuery.mock.calls[1][0];
    expect(countSql).toContain("websearch_to_tsquery");
    expect(countSql).toContain("session_id = $1");
    expect(dataSql).toContain("ts_rank");
    expect(dataSql).toContain("ORDER BY rank DESC");
  });

  it("filters by role", async () => {
    // FTS returns 1 result so trigram fallback is not triggered
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1", session_id: "s1", role: "assistant", content: "x",
        images: null, model: null, tool_calls: null, tool_results: null,
        approval_status: null, timestamp: 1000, rank: 0.5,
      }],
    });

    await searchSessionMessages({
      sessionId: "s1",
      query: "test",
      role: "assistant",
    });

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("role = $3");
    expect(mockQuery.mock.calls[0][1]).toContain("assistant");
  });

  it("clamps limit to 50", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1", session_id: "s1", role: "user", content: "x",
        images: null, model: null, tool_calls: null, tool_results: null,
        approval_status: null, timestamp: 1000, rank: 0.5,
      }],
    });

    await searchSessionMessages({
      sessionId: "s1",
      query: "test",
      limit: 200,
    });

    const dataParams = mockQuery.mock.calls[1][1];
    expect(dataParams).toContain(50);
  });

  it("falls back to ILIKE when FTS returns no results", async () => {
    // FTS returns 0
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Trigram fallback
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1", session_id: "s1", role: "user", content: "mgruts data",
        images: null, model: null, tool_calls: null, tool_results: null,
        approval_status: null, timestamp: 1000, rank: 1,
      }],
    });

    const result = await searchSessionMessages({
      sessionId: "s1",
      query: "mgru",
    });

    expect(result.total).toBe(1);
    // Fallback query uses ILIKE
    const fallbackSql = mockQuery.mock.calls[2][0];
    expect(fallbackSql).toContain("ILIKE");
  });
});

describe("searchAllMessages", () => {
  it("joins sessions and uses full-text search", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "m1",
          session_id: "s2",
          role: "user",
          content: "Docker notes",
          images: null,
          model: null,
          tool_calls: null,
          tool_results: null,
          approval_status: null,
          timestamp: 2000,
          session_title: "Docker project",
          rank: 0.8,
        },
      ],
    });

    const result = await searchAllMessages({ query: "docker" });

    expect(result.total).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("Docker notes");
    expect(result.messages[0].sessionTitle).toBe("Docker project");

    const dataSql = mockQuery.mock.calls[1][0];
    expect(dataSql).toContain("JOIN sessions");
    expect(dataSql).toContain("session_title");
    expect(dataSql).toContain("websearch_to_tsquery");
  });

  it("excludes session when excludeSessionId provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1", session_id: "s2", role: "user", content: "x",
        images: null, model: null, tool_calls: null, tool_results: null,
        approval_status: null, timestamp: 1000, session_title: "Other", rank: 0.5,
      }],
    });

    await searchAllMessages({
      query: "test",
      excludeSessionId: "s1",
    });

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("session_id != $2");
    expect(mockQuery.mock.calls[0][1]).toContain("s1");
  });

  it("does not exclude when no excludeSessionId", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1", session_id: "s1", role: "user", content: "x",
        images: null, model: null, tool_calls: null, tool_results: null,
        approval_status: null, timestamp: 1000, session_title: "Chat", rank: 0.5,
      }],
    });

    await searchAllMessages({ query: "test" });

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).not.toContain("session_id !=");
  });

  it("falls back to ILIKE when FTS returns no results", async () => {
    // FTS returns 0
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Trigram fallback
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "m1", session_id: "s2", role: "user", content: "mgruts data",
        images: null, model: null, tool_calls: null, tool_results: null,
        approval_status: null, timestamp: 1000, session_title: "Other", rank: 1,
      }],
    });

    const result = await searchAllMessages({ query: "mgru" });

    expect(result.total).toBe(1);
    const fallbackSql = mockQuery.mock.calls[2][0];
    expect(fallbackSql).toContain("ILIKE");
  });
});

describe("atomicApprove", () => {
  it("returns true when message was pending and got approved", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await atomicApprove("msg-1");
    expect(result).toBe(true);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("UPDATE messages");
    expect(sql).toContain("approval_status = 'approved'");
    expect(sql).toContain("approval_status = 'pending'");
    expect(params).toEqual(["msg-1"]);
  });

  it("returns false when message was already approved (concurrent request)", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const result = await atomicApprove("msg-1");
    expect(result).toBe(false);
  });

  it("returns false when rowCount is null", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: null });

    const result = await atomicApprove("msg-1");
    expect(result).toBe(false);
  });
});

describe("getSessionAutoApprove", () => {
  it("returns true when auto_approve is enabled", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ auto_approve: true }],
    });

    const result = await getSessionAutoApprove("s1");
    expect(result).toBe(true);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("SELECT auto_approve FROM sessions");
    expect(params).toEqual(["s1"]);
  });

  it("returns false when auto_approve is disabled", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ auto_approve: false }],
    });

    const result = await getSessionAutoApprove("s1");
    expect(result).toBe(false);
  });

  it("returns false for missing session", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getSessionAutoApprove("nonexistent");
    expect(result).toBe(false);
  });
});

describe("updateSession", () => {
  it("updates title only", async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "s1", title: "Updated", auto_approve: false, created_at: now, updated_at: now }],
    });

    const session = await updateSession("s1", { title: "Updated" });
    expect(session).not.toBeNull();
    expect(session!.title).toBe("Updated");

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("UPDATE sessions SET");
    expect(sql).toContain("title =");
    expect(sql).not.toContain("auto_approve =");
    expect(params).toContain("Updated");
    expect(params).toContain("s1");
  });

  it("updates autoApprove only", async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "s1", title: "Chat", auto_approve: true, created_at: now, updated_at: now }],
    });

    const session = await updateSession("s1", { autoApprove: true });
    expect(session).not.toBeNull();
    expect(session!.autoApprove).toBe(true);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("auto_approve =");
    expect(sql).not.toContain("title =");
    expect(params).toContain(true);
    expect(params).toContain("s1");
  });

  it("updates both title and autoApprove", async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "s1", title: "New", auto_approve: true, created_at: now, updated_at: now }],
    });

    const session = await updateSession("s1", { title: "New", autoApprove: true });
    expect(session).not.toBeNull();
    expect(session!.title).toBe("New");
    expect(session!.autoApprove).toBe(true);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("title =");
    expect(sql).toContain("auto_approve =");
  });

  it("returns null when no fields provided", async () => {
    const session = await updateSession("s1", {});
    expect(session).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns null for missing session", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const session = await updateSession("nonexistent", { title: "X" });
    expect(session).toBeNull();
  });
});
