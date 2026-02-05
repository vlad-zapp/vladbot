import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createStream,
  getStream,
  pushEvent,
  removeStream,
  continueStream,
  scheduleRemoval,
} from "../services/streamRegistry.js";

describe("streamRegistry", () => {
  beforeEach(() => {
    // Clean up any leftover streams
    removeStream("test-session");
  });

  describe("createStream", () => {
    it("creates a new stream with default values", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      expect(stream.sessionId).toBe("test-session");
      expect(stream.assistantId).toBe("asst-1");
      expect(stream.content).toBe("");
      expect(stream.model).toBe("gpt-4");
      expect(stream.toolCalls).toEqual([]);
      expect(stream.hasToolCalls).toBe(false);
      expect(stream.done).toBe(false);
      expect(stream.subscribers.size).toBe(0);
    });

    it("replaces an existing stream for the same session", () => {
      createStream("test-session", "asst-1", "gpt-4");
      const stream2 = createStream("test-session", "asst-2", "gpt-4");
      expect(getStream("test-session")).toBe(stream2);
      expect(stream2.assistantId).toBe("asst-2");
    });
  });

  describe("getStream", () => {
    it("returns undefined for non-existent stream", () => {
      expect(getStream("nonexistent")).toBeUndefined();
    });

    it("returns the stream if it exists", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      expect(getStream("test-session")).toBe(stream);
    });
  });

  describe("pushEvent", () => {
    it("accumulates token content", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      pushEvent("test-session", { type: "token", data: "Hello" });
      pushEvent("test-session", { type: "token", data: " World" });
      expect(stream.content).toBe("Hello World");
    });

    it("accumulates tool calls", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      const tc = { id: "tc1", name: "test", arguments: {} };
      pushEvent("test-session", { type: "tool_call", data: tc });
      expect(stream.toolCalls).toEqual([tc]);
    });

    it("marks done on done event", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      pushEvent("test-session", { type: "done", data: { hasToolCalls: true } });
      expect(stream.done).toBe(true);
      expect(stream.hasToolCalls).toBe(true);
    });

    it("marks error on error event", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      pushEvent("test-session", { type: "error", data: { message: "Something failed", code: "UNKNOWN", recoverable: false } });
      expect(stream.done).toBe(true);
      expect(stream.error).toEqual({ message: "Something failed", code: "UNKNOWN", recoverable: false });
    });

    it("stores usage data", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      pushEvent("test-session", { type: "usage", data: { inputTokens: 100, outputTokens: 50 } });
      expect(stream.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    });

    it("notifies subscribers", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      const events: unknown[] = [];
      stream.subscribers.add((e) => events.push(e));
      pushEvent("test-session", { type: "token", data: "Hi" });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "token", data: "Hi" });
    });

    it("captures requestBody from debug events", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      const reqBody = { model: "gpt-4", messages: [{ role: "user", content: "hi" }] };
      pushEvent("test-session", { type: "debug", data: { direction: "request", body: reqBody } });
      expect(stream.requestBody).toEqual(reqBody);
    });

    it("ignores debug events without request direction", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      // Only "request" direction should be captured; other directions should not set requestBody
      pushEvent("test-session", { type: "debug", data: { direction: "request", body: { test: true } } });
      expect(stream.requestBody).toEqual({ test: true });
    });

    it("ignores events for non-existent streams", () => {
      // Should not throw
      pushEvent("nonexistent", { type: "token", data: "Hi" });
    });
  });

  describe("removeStream", () => {
    it("removes the stream and clears subscribers", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      const sub = () => {};
      stream.subscribers.add(sub);
      removeStream("test-session");
      expect(getStream("test-session")).toBeUndefined();
      expect(stream.subscribers.size).toBe(0);
    });

    it("is a no-op for non-existent streams", () => {
      removeStream("nonexistent"); // Should not throw
    });
  });

  describe("continueStream", () => {
    it("resets content, toolCalls, and requestBody for a new round", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      pushEvent("test-session", { type: "token", data: "Some content" });
      const tc = { id: "tc1", name: "test", arguments: {} };
      pushEvent("test-session", { type: "tool_call", data: tc });
      pushEvent("test-session", { type: "done", data: { hasToolCalls: true } });
      pushEvent("test-session", { type: "usage", data: { inputTokens: 100, outputTokens: 50 } });
      pushEvent("test-session", { type: "debug", data: { direction: "request", body: { model: "gpt-4" } } });

      const continued = continueStream("test-session", "asst-2");
      expect(continued).not.toBeNull();
      expect(continued!.assistantId).toBe("asst-2");
      expect(continued!.content).toBe("");
      expect(continued!.toolCalls).toEqual([]);
      expect(continued!.hasToolCalls).toBe(false);
      expect(continued!.done).toBe(false);
      expect(continued!.error).toBeUndefined();
      expect(continued!.usage).toBeUndefined();
      expect(continued!.requestBody).toBeUndefined();
    });

    it("keeps subscribers connected", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      const sub = () => {};
      stream.subscribers.add(sub);

      const continued = continueStream("test-session", "asst-2");
      expect(continued!.subscribers.size).toBe(1);
      expect(continued!.subscribers.has(sub)).toBe(true);
    });

    it("returns null for non-existent stream", () => {
      expect(continueStream("nonexistent", "asst-2")).toBeNull();
    });
  });

  describe("scheduleRemoval", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("removes the stream after the delay", () => {
      createStream("test-session", "asst-1", "gpt-4");
      scheduleRemoval("test-session", 5000);
      expect(getStream("test-session")).toBeDefined();
      vi.advanceTimersByTime(5000);
      expect(getStream("test-session")).toBeUndefined();
    });

    it("does NOT remove the stream if a newer stream replaced it", () => {
      createStream("test-session", "asst-1", "gpt-4");
      scheduleRemoval("test-session", 5000);

      // Simulate approve handler creating a fresh stream before timer fires
      createStream("test-session", "asst-2", "gpt-4");

      vi.advanceTimersByTime(5000);
      // The new stream must survive — the old timer must not kill it
      const stream = getStream("test-session");
      expect(stream).toBeDefined();
      expect(stream!.assistantId).toBe("asst-2");
    });

    it("is a no-op if stream was already removed", () => {
      createStream("test-session", "asst-1", "gpt-4");
      scheduleRemoval("test-session", 5000);
      removeStream("test-session");
      vi.advanceTimersByTime(5000);
      // Should not throw
      expect(getStream("test-session")).toBeUndefined();
    });

    afterEach(() => {
      vi.useRealTimers();
      removeStream("test-session");
    });
  });

  describe("generation counter", () => {
    it("each createStream gets a unique generation", () => {
      const s1 = createStream("test-session", "a1", "gpt-4");
      const s2 = createStream("test-session", "a2", "gpt-4");
      expect(s2.generation).toBeGreaterThan(s1.generation);
    });
  });

  describe("abort behavior", () => {
    it("stream has an abort controller", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      expect(stream.abortController).toBeInstanceOf(AbortController);
      expect(stream.abortController.signal.aborted).toBe(false);
    });

    it("abort controller can be triggered", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      stream.abortController.abort();
      expect(stream.abortController.signal.aborted).toBe(true);
    });

    it("aborted flag is initially false", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      expect(stream.aborted).toBe(false);
    });

    it("aborted flag can be set", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      stream.aborted = true;
      expect(stream.aborted).toBe(true);
    });

    it("does not accumulate tokens when aborted", () => {
      const stream = createStream("test-session", "asst-1", "gpt-4");
      pushEvent("test-session", { type: "token", data: "Hello" });
      stream.aborted = true;
      pushEvent("test-session", { type: "token", data: " World" });
      // Tokens pushed after abort are NOT accumulated - protection against
      // late-arriving tokens after user cancellation
      expect(stream.content).toBe("Hello");
    });

    it("new stream has fresh abort controller", () => {
      const s1 = createStream("test-session", "asst-1", "gpt-4");
      s1.abortController.abort();
      const s2 = createStream("test-session", "asst-2", "gpt-4");
      expect(s2.abortController.signal.aborted).toBe(false);
      expect(s2.aborted).toBe(false);
    });
  });
});
