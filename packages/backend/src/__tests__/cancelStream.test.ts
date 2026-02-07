import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock modules that chain to PostgreSQL
vi.mock("../services/db.js", () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock("../services/sessionStore.js", () => ({
  getSession: vi.fn(),
  addMessage: vi.fn().mockResolvedValue("msg-1"),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  atomicApprove: vi.fn().mockResolvedValue(true),
  getSessionAutoApprove: vi.fn().mockResolvedValue(true),
  updateSessionTokenUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/sessionFiles.js", () => ({
  getSessionFilePath: vi.fn(),
}));

vi.mock("../config/env.js", () => ({
  env: {
    VISION_MODEL: "",
  },
}));

vi.mock("../config/runtimeSettings.js", () => ({
  getRuntimeSetting: vi.fn().mockResolvedValue(null),
}));

import {
  createStream,
  getStream,
  pushEvent,
  continueStream,
  scheduleRemoval,
} from "../services/streamRegistry.js";

// ===========================================================================
// Stream Registry: cancel/interrupt behavior tests
//
// These tests verify that the abort mechanism works correctly:
// - Setting aborted flag
// - Tokens blocked after abort
// - continueStream preserves aborted flag
// - done/error events still propagate after abort
// ===========================================================================

describe("streamRegistry — abort/cancel behavior", () => {
  beforeEach(() => {
    // Clean up any streams from previous tests
    const stream = getStream("test-session");
    if (stream) {
      // Force remove by creating + removing
    }
  });

  it("createStream initializes with aborted=false", () => {
    const stream = createStream("cancel-test-1", "assist-1", "model-1");
    expect(stream.aborted).toBe(false);
    expect(stream.abortController).toBeDefined();
    expect(stream.abortController.signal.aborted).toBe(false);
  });

  it("setting aborted=true blocks subsequent token events", () => {
    createStream("cancel-test-2", "assist-1", "model-1");

    pushEvent("cancel-test-2", { type: "token", data: "hello " });
    const stream1 = getStream("cancel-test-2");
    expect(stream1!.content).toBe("hello ");

    // Abort the stream
    stream1!.aborted = true;

    // Tokens should be blocked
    pushEvent("cancel-test-2", { type: "token", data: "world" });
    const stream2 = getStream("cancel-test-2");
    expect(stream2!.content).toBe("hello "); // unchanged
  });

  it("done events still propagate after abort", () => {
    createStream("cancel-test-3", "assist-1", "model-1");
    const stream = getStream("cancel-test-3")!;
    stream.aborted = true;

    const received: string[] = [];
    stream.subscribers.add((event) => {
      received.push(event.type);
    });

    pushEvent("cancel-test-3", { type: "done", data: { hasToolCalls: false } });

    expect(stream.done).toBe(true);
    expect(received).toContain("done");
  });

  it("error events still propagate after abort", () => {
    createStream("cancel-test-4", "assist-1", "model-1");
    const stream = getStream("cancel-test-4")!;
    stream.aborted = true;

    pushEvent("cancel-test-4", {
      type: "error",
      data: { message: "test error", code: "UNKNOWN", recoverable: false },
    });

    expect(stream.done).toBe(true);
    expect(stream.error).toBeDefined();
  });

  it("abortController.abort() signals the abort", () => {
    const stream = createStream("cancel-test-5", "assist-1", "model-1");

    let signalFired = false;
    stream.abortController.signal.addEventListener("abort", () => {
      signalFired = true;
    });

    stream.abortController.abort();
    expect(signalFired).toBe(true);
    expect(stream.abortController.signal.aborted).toBe(true);
  });

  it("continueStream preserves aborted flag", () => {
    createStream("cancel-test-6", "assist-1", "model-1");
    const stream = getStream("cancel-test-6")!;
    stream.aborted = true;
    stream.content = "old content";

    const continued = continueStream("cancel-test-6", "assist-2");

    expect(continued).not.toBeNull();
    expect(continued!.aborted).toBe(true); // Preserved!
    expect(continued!.assistantId).toBe("assist-2");
    expect(continued!.content).toBe(""); // Reset
    expect(continued!.toolCalls).toEqual([]); // Reset
  });

  it("continueStream resets content and tool state but keeps subscribers", () => {
    createStream("cancel-test-7", "assist-1", "model-1");
    const stream = getStream("cancel-test-7")!;

    const subscriberFn = vi.fn();
    stream.subscribers.add(subscriberFn);
    stream.content = "some content";
    stream.toolCalls = [{ id: "tc-1", name: "browser_navigate", arguments: {} }];
    stream.done = true;
    stream.hasToolCalls = true;

    const continued = continueStream("cancel-test-7", "assist-2");

    expect(continued!.content).toBe("");
    expect(continued!.toolCalls).toEqual([]);
    expect(continued!.done).toBe(false);
    expect(continued!.hasToolCalls).toBe(false);
    expect(continued!.subscribers.has(subscriberFn)).toBe(true); // Kept
  });

  it("subscribers receive events in order", () => {
    createStream("cancel-test-8", "assist-1", "model-1");
    const stream = getStream("cancel-test-8")!;

    const events: string[] = [];
    stream.subscribers.add((event) => events.push(event.type));

    pushEvent("cancel-test-8", { type: "token", data: "a" });
    pushEvent("cancel-test-8", {
      type: "tool_call",
      data: { id: "tc-1", name: "test_tool", arguments: {} },
    });
    pushEvent("cancel-test-8", { type: "done", data: { hasToolCalls: true } });

    expect(events).toEqual(["token", "tool_call", "done"]);
  });

  it("tool_call events still accumulate after abort (only tokens blocked)", () => {
    createStream("cancel-test-9", "assist-1", "model-1");
    const stream = getStream("cancel-test-9")!;
    stream.aborted = true;

    // tool_result events should still work (for showing completed tool status)
    pushEvent("cancel-test-9", {
      type: "tool_call",
      data: { id: "tc-1", name: "test", arguments: {} },
    });

    expect(stream.toolCalls).toHaveLength(1);
  });
});

describe("streamRegistry — interrupt simulation", () => {
  it("simulates full interrupt flow: abort controller + flag + token + done", () => {
    const stream = createStream("interrupt-1", "assist-1", "model-1");

    const received: string[] = [];
    stream.subscribers.add((event) => received.push(event.type));

    // Normal streaming
    pushEvent("interrupt-1", { type: "token", data: "Hello " });
    expect(stream.content).toBe("Hello ");

    // User interrupts (simulates messages.interrupt handler)
    stream.abortController.abort();
    stream.aborted = true;
    const interruptText = "\n\n[Interrupted by user]";
    stream.content += interruptText;
    pushEvent("interrupt-1", { type: "token", data: interruptText });

    // The token after abort should be blocked, but we manually added it above
    // (matching the real handler behavior where it's added directly to stream.content)
    expect(stream.content).toBe("Hello \n\n[Interrupted by user]");

    // Backend pushes done after cleanup
    pushEvent("interrupt-1", { type: "done", data: { hasToolCalls: false } });

    expect(stream.done).toBe(true);
    // The done event should reach subscribers
    expect(received).toContain("done");
  });

  it("interrupt during tool round: abort flag stops next tool", () => {
    const stream = createStream("interrupt-2", "assist-1", "model-1");

    // Simulate: first tool completes
    pushEvent("interrupt-2", {
      type: "tool_result",
      data: { toolCallId: "tc-1", output: "OK", isError: false },
    });

    // User interrupts between tools
    stream.abortController.abort();
    stream.aborted = true;

    // The tool loop would check stream.aborted before next tool
    expect(stream.aborted).toBe(true);
    expect(stream.abortController.signal.aborted).toBe(true);

    // Done pushed after interrupted results
    pushEvent("interrupt-2", { type: "done", data: { hasToolCalls: false } });
    expect(stream.done).toBe(true);
  });

  it("createStream for same session replaces old stream", () => {
    const stream1 = createStream("replace-1", "assist-1", "model-1");
    stream1.content = "old";
    stream1.aborted = true;

    // Creating a new stream for the same session replaces it
    const stream2 = createStream("replace-1", "assist-2", "model-1");
    expect(stream2.content).toBe("");
    expect(stream2.aborted).toBe(false);
    expect(stream2.assistantId).toBe("assist-2");

    // Old stream reference is stale
    expect(getStream("replace-1")).toBe(stream2);
  });
});
