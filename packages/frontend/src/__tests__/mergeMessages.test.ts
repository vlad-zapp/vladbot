import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@vladbot/shared";
import { mergeMessages } from "../hooks/useChat.js";

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("mergeMessages", () => {
  it("preserves local object reference when content is unchanged", () => {
    const local = [
      msg({ id: "1", role: "user", content: "hello" }),
      msg({ id: "2", content: "hi there" }),
    ];
    const db = [
      msg({ id: "1", role: "user", content: "hello" }),
      msg({ id: "2", content: "hi there" }),
    ];

    const merged = mergeMessages(local, db);

    // Same references — React won't re-render
    expect(merged[0]).toBe(local[0]);
    expect(merged[1]).toBe(local[1]);
  });

  it("uses DB message when content differs", () => {
    const local = [msg({ id: "1", content: "old content" })];
    const db = [msg({ id: "1", content: "updated content" })];

    const merged = mergeMessages(local, db);

    expect(merged[0]).toBe(db[0]);
    expect(merged[0].content).toBe("updated content");
  });

  it("adds new messages from DB that are not in local state", () => {
    const local = [msg({ id: "1", content: "hi" })];
    const db = [
      msg({ id: "1", content: "hi" }),
      msg({ id: "tool-1", role: "tool", content: "" }),
      msg({ id: "2", content: "follow-up" }),
    ];

    const merged = mergeMessages(local, db);

    expect(merged).toHaveLength(3);
    expect(merged[0]).toBe(local[0]); // preserved
    expect(merged[1]).toBe(db[1]); // new from DB
    expect(merged[2]).toBe(db[2]); // new from DB
  });

  it("updates when approvalStatus changes", () => {
    const local = [
      msg({ id: "1", content: "text", approvalStatus: "pending" }),
    ];
    const db = [
      msg({ id: "1", content: "text", approvalStatus: "approved" }),
    ];

    const merged = mergeMessages(local, db);

    expect(merged[0]).toBe(db[0]);
    expect(merged[0].approvalStatus).toBe("approved");
  });

  it("updates when toolResults are added", () => {
    const local = [
      msg({
        id: "1",
        content: "text",
        toolCalls: [{ id: "tc1", name: "screenshot", arguments: {} }],
      }),
    ];
    const db = [
      msg({
        id: "1",
        content: "text",
        toolCalls: [{ id: "tc1", name: "screenshot", arguments: {} }],
        toolResults: [{ toolCallId: "tc1", output: "done", isError: false }],
      }),
    ];

    const merged = mergeMessages(local, db);

    expect(merged[0]).toBe(db[0]);
    expect(merged[0].toolResults).toHaveLength(1);
  });

  it("preserves local reference when only non-visible fields differ", () => {
    const local = [msg({ id: "1", content: "text" })];
    const db = [
      {
        ...msg({ id: "1", content: "text" }),
        llmRequest: { some: "data" },
        llmResponse: { content: "text" },
      },
    ];

    const merged = mergeMessages(local, db);

    // Same visible content — keep local reference
    expect(merged[0]).toBe(local[0]);
  });

  it("handles empty local state (initial load)", () => {
    const db = [
      msg({ id: "1", role: "user", content: "hello" }),
      msg({ id: "2", content: "response" }),
    ];

    const merged = mergeMessages([], db);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(db[0]);
    expect(merged[1]).toBe(db[1]);
  });

  it("uses DB order, not local order", () => {
    const local = [
      msg({ id: "2", content: "second" }),
      msg({ id: "1", content: "first" }),
    ];
    const db = [
      msg({ id: "1", content: "first" }),
      msg({ id: "2", content: "second" }),
    ];

    const merged = mergeMessages(local, db);

    expect(merged[0].id).toBe("1");
    expect(merged[1].id).toBe("2");
    // References preserved despite different order
    expect(merged[0]).toBe(local[1]);
    expect(merged[1]).toBe(local[0]);
  });

  it("updates when images are added", () => {
    const local = [msg({ id: "1", role: "user", content: "text" })];
    const db = [
      msg({ id: "1", role: "user", content: "text", images: ["/uploads/img.png"] }),
    ];

    const merged = mergeMessages(local, db);

    expect(merged[0]).toBe(db[0]);
    expect(merged[0].images).toHaveLength(1);
  });

  it("preserves local when toolCalls count matches", () => {
    const tc = { id: "tc1", name: "run", arguments: { cmd: "ls" } };
    const local = [msg({ id: "1", content: "ok", toolCalls: [tc] })];
    const db = [msg({ id: "1", content: "ok", toolCalls: [tc] })];

    const merged = mergeMessages(local, db);

    expect(merged[0]).toBe(local[0]);
  });

  it("uses DB version when local is missing tokenCount", () => {
    const local = [msg({ id: "1", content: "hello" })];
    const db = [msg({ id: "1", content: "hello", tokenCount: 5 })];

    const merged = mergeMessages(local, db);

    expect(merged[0]).toBe(db[0]);
    expect(merged[0].tokenCount).toBe(5);
  });

  it("uses DB version when local is missing rawTokenCount", () => {
    const local = [msg({ id: "1", content: "hello", tokenCount: 5 })];
    const db = [msg({ id: "1", content: "hello", tokenCount: 5, rawTokenCount: 100 })];

    const merged = mergeMessages(local, db);

    expect(merged[0]).toBe(db[0]);
    expect(merged[0].rawTokenCount).toBe(100);
  });

  it("preserves local when both have token counts", () => {
    const local = [msg({ id: "1", content: "hello", tokenCount: 5, rawTokenCount: 100 })];
    const db = [msg({ id: "1", content: "hello", tokenCount: 5, rawTokenCount: 100 })];

    const merged = mergeMessages(local, db);

    expect(merged[0]).toBe(local[0]);
  });

  it("preserves local when DB also has no token counts", () => {
    const local = [msg({ id: "1", content: "hello" })];
    const db = [msg({ id: "1", content: "hello" })];

    const merged = mergeMessages(local, db);

    expect(merged[0]).toBe(local[0]);
  });

  it("preserves older local messages not in DB page", () => {
    // Simulate: user loaded older messages via infinite scroll, then a
    // post-stream reload fetches only the latest page from the DB.
    const local = [
      msg({ id: "old-1", content: "ancient" }),
      msg({ id: "old-2", content: "old" }),
      msg({ id: "3", content: "recent" }),
      msg({ id: "4", content: "latest" }),
    ];
    const db = [
      msg({ id: "3", content: "recent" }),
      msg({ id: "4", content: "latest" }),
    ];

    const merged = mergeMessages(local, db);

    expect(merged).toHaveLength(4);
    expect(merged[0]).toBe(local[0]); // preserved older
    expect(merged[1]).toBe(local[1]); // preserved older
    expect(merged[2]).toBe(local[2]); // preserved reference
    expect(merged[3]).toBe(local[3]); // preserved reference
  });

  it("does not duplicate when local and DB fully overlap", () => {
    const local = [
      msg({ id: "1", content: "a" }),
      msg({ id: "2", content: "b" }),
    ];
    const db = [
      msg({ id: "1", content: "a" }),
      msg({ id: "2", content: "b" }),
    ];

    const merged = mergeMessages(local, db);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(local[0]);
    expect(merged[1]).toBe(local[1]);
  });

  it("updates to cancelled status from DB", () => {
    // When user cancels a tool, the backend saves with cancelled status.
    // The frontend should honor the DB value (source of truth).
    const local = [
      msg({ id: "1", content: "text", approvalStatus: "pending" }),
    ];
    const db = [
      msg({ id: "1", content: "text", approvalStatus: "cancelled" }),
    ];

    const merged = mergeMessages(local, db);

    // Backend is source of truth - cancelled status from DB should be used
    expect(merged[0]).toBe(db[0]);
    expect(merged[0].approvalStatus).toBe("cancelled");
  });

  it("shows cancelled status consistently after DB sync", () => {
    // After interrupt, both local and DB have cancelled status - preserve reference
    const local = [
      msg({ id: "1", content: "text", approvalStatus: "cancelled" }),
    ];
    const db = [
      msg({ id: "1", content: "text", approvalStatus: "cancelled" }),
    ];

    const merged = mergeMessages(local, db);

    // Same status - preserve local reference to avoid re-renders
    expect(merged[0]).toBe(local[0]);
    expect(merged[0].approvalStatus).toBe("cancelled");
  });
});
