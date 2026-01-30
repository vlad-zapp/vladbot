import { describe, it, expect } from "vitest";

/**
 * Tests for sendMessage race conditions.
 *
 * These test the synchronous guard and stale-session patterns used in
 * useChat's sendMessage logic.  We don't render the hook — instead we
 * simulate the control-flow that matters.
 */

describe("sendMessage — double-send guard", () => {
  it("blocks concurrent calls via synchronous isStreamingRef guard", async () => {
    const isStreamingRef = { current: false };
    const calls: number[] = [];

    async function sendMessage(n: number) {
      if (isStreamingRef.current) return;
      isStreamingRef.current = true; // synchronous guard — must be set before any await
      calls.push(n);
      try {
        await Promise.resolve(); // simulate async gap (onEnsureSession / saveMessage)
      } finally {
        isStreamingRef.current = false;
      }
    }

    // Fire two calls concurrently — only the first should execute
    const p1 = sendMessage(1);
    const p2 = sendMessage(2);
    await Promise.all([p1, p2]);

    expect(calls).toEqual([1]);
  });

  it("allows a new call after the first one completes", async () => {
    const isStreamingRef = { current: false };
    const calls: number[] = [];

    async function sendMessage(n: number) {
      if (isStreamingRef.current) return;
      isStreamingRef.current = true;
      calls.push(n);
      try {
        await Promise.resolve();
      } finally {
        isStreamingRef.current = false;
      }
    }

    await sendMessage(1);
    await sendMessage(2);

    expect(calls).toEqual([1, 2]);
  });
});

describe("sendMessage — stale session guard", () => {
  it("skips state updates when session changed during async work", async () => {
    // Simulates: user sends message in session A, switches to B mid-stream.
    // The post-stream fetchMessages for A must NOT overwrite B's messages.
    let currentSessionId = "session-A";
    let messages: string[] = [];

    async function sendMessage(sessionId: string) {
      await Promise.resolve(); // simulate saveMessage
      if (currentSessionId !== sessionId) return; // stale check
      messages = [`msg-from-${sessionId}`];

      await Promise.resolve(); // simulate streamTurn + fetchMessages
      if (currentSessionId !== sessionId) return; // stale check
      messages = [`reloaded-from-${sessionId}`];
    }

    async function switchSession(newId: string) {
      currentSessionId = newId;
      messages = [`loaded-from-${newId}`];
    }

    const sendP = sendMessage("session-A");
    // User switches to session B before sendMessage finishes
    await switchSession("session-B");
    await sendP;

    // Session B's data must be preserved — session A's stale writes were skipped
    expect(messages).toEqual([`loaded-from-session-B`]);
  });

  it("applies state updates when session has not changed", async () => {
    let currentSessionId = "session-A";
    let messages: string[] = [];

    async function sendMessage(sessionId: string) {
      await Promise.resolve();
      if (currentSessionId !== sessionId) return;
      messages = [`msg-from-${sessionId}`];

      await Promise.resolve();
      if (currentSessionId !== sessionId) return;
      messages = [`reloaded-from-${sessionId}`];
    }

    await sendMessage("session-A");

    // No session switch — normal flow
    expect(messages).toEqual([`reloaded-from-session-A`]);
  });
});
