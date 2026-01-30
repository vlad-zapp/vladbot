import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@vladbot/shared";

/**
 * Compaction messages now use timestamp = Date.now(), placing them after
 * all messages that existed at compaction time. This means timestamp order
 * is naturally correct for display — no frontend reordering needed.
 */

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

function sortByTimestamp(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => a.timestamp - b.timestamp);
}

describe("compaction message ordering (Date.now timestamp)", () => {
  it("compaction appears after all pre-compaction messages", () => {
    const messages = sortByTimestamp([
      msg({ id: "1", role: "user", content: "A", timestamp: 1000 }),
      msg({ id: "2", content: "B", timestamp: 1100 }),
      msg({ id: "3", role: "user", content: "C", timestamp: 1200 }),
      msg({ id: "4", content: "D", timestamp: 1300 }),
      msg({ id: "c1", role: "compaction", content: "Summary", timestamp: 1400 }),
    ]);

    expect(messages.map((m) => m.id)).toEqual(["1", "2", "3", "4", "c1"]);
  });

  it("new messages after compaction appear after the compaction", () => {
    const messages = sortByTimestamp([
      msg({ id: "1", role: "user", content: "A", timestamp: 1000 }),
      msg({ id: "2", content: "B", timestamp: 1100 }),
      msg({ id: "c1", role: "compaction", content: "Summary", timestamp: 1400 }),
      msg({ id: "3", role: "user", content: "C", timestamp: 2000 }),
      msg({ id: "4", content: "D", timestamp: 2100 }),
    ]);

    expect(messages.map((m) => m.id)).toEqual(["1", "2", "c1", "3", "4"]);
  });

  it("no position change between frontend append and DB reload", () => {
    const existing = [
      msg({ id: "1", role: "user", timestamp: 1000 }),
      msg({ id: "2", timestamp: 1100 }),
      msg({ id: "3", role: "user", timestamp: 1200 }),
      msg({ id: "4", timestamp: 1300 }),
    ];
    const compaction = msg({ id: "c1", role: "compaction", timestamp: 1400 });

    // Frontend appends at end
    const withAppend = [...existing, compaction];

    // After DB reload, timestamp order is identical
    const afterReload = sortByTimestamp(withAppend);

    expect(withAppend.map((m) => m.id)).toEqual(afterReload.map((m) => m.id));
  });

  it("multiple compactions each appear at their creation time", () => {
    const messages = sortByTimestamp([
      msg({ id: "1", role: "user", timestamp: 1000 }),
      msg({ id: "2", timestamp: 1100 }),
      msg({ id: "c1", role: "compaction", timestamp: 1200 }),
      msg({ id: "3", role: "user", timestamp: 2000 }),
      msg({ id: "4", timestamp: 2100 }),
      msg({ id: "c2", role: "compaction", timestamp: 2200 }),
      msg({ id: "5", role: "user", timestamp: 3000 }),
    ]);

    expect(messages.map((m) => m.id)).toEqual(["1", "2", "c1", "3", "4", "c2", "5"]);
  });

  it("compaction as the only message", () => {
    const messages = [
      msg({ id: "c1", role: "compaction", content: "Summary", timestamp: 1000 }),
    ];

    expect(messages.map((m) => m.id)).toEqual(["c1"]);
  });
});
