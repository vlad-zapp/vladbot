import { describe, it, expect } from "vitest";

/**
 * Tests for session switching during streaming.
 *
 * These test the StreamState patterns used in useChat:
 * - streamStateRef encapsulates sessionId, aborted flag, and activeStream metadata
 * - sendingRef is a separate synchronous guard against double-send
 * - sessionIdRef tracks the currently viewed session
 *
 * We don't render the hook — instead we simulate the control-flow that matters.
 */

interface StreamState {
  sessionId: string;
  aborted: boolean;
  activeStream: {
    assistantId: string;
    content: string;
    model: string;
    toolCalls: unknown[];
  } | null;
}

describe("session switching — streaming isolation", () => {
  it("stream events for old session don't update UI after switching", async () => {
    let streamState: StreamState | null = null;
    let sessionIdRef = "session-A";
    let isStreaming = false;
    let messages: string[] = [];

    async function streamTurn(sessionId: string) {
      streamState = { sessionId, aborted: false, activeStream: null };
      isStreaming = true;

      // Simulate receiving tokens
      await Promise.resolve();
      // Stale check: only update if still viewing this session
      if (sessionIdRef === sessionId) {
        messages.push("token-from-" + sessionId);
      }

      // Done
      await Promise.resolve();
      if (sessionIdRef === sessionId) {
        isStreaming = false;
      }
      if (streamState?.sessionId === sessionId) {
        streamState = null;
      }
    }

    function switchSession(newId: string) {
      sessionIdRef = newId;
      messages = [];
      // Derive isStreaming for the new session
      isStreaming = streamState?.sessionId === newId;
    }

    // Start streaming on session A
    const streamP = streamTurn("session-A");

    // Switch to session B before streaming finishes
    switchSession("session-B");

    await streamP;

    // Session B should be clean — no tokens from A leaked in
    expect(messages).toEqual([]);
    expect(isStreaming).toBe(false);
    // Stream state should be cleaned up
    expect(streamState).toBeNull();
  });

  it("switching back to a streaming session restores isStreaming", async () => {
    let streamState: StreamState | null = null;
    let sessionIdRef = "session-A";
    let isStreaming = false;
    let resolve!: () => void;
    const streamDone = new Promise<void>((r) => { resolve = r; });

    function startStream(sessionId: string) {
      streamState = {
        sessionId,
        aborted: false,
        activeStream: { assistantId: "a1", content: "hello", model: "m", toolCalls: [] },
      };
      isStreaming = true;
    }

    function switchSession(newId: string) {
      sessionIdRef = newId;
      isStreaming = streamState?.sessionId === newId;
    }

    // Start streaming on session A
    startStream("session-A");
    expect(isStreaming).toBe(true);

    // Switch to session B
    switchSession("session-B");
    expect(isStreaming).toBe(false);

    // Switch back to session A — should see streaming
    switchSession("session-A");
    expect(isStreaming).toBe(true);

    // Active stream metadata should be available for UI restoration
    expect((streamState as StreamState | null)?.activeStream?.content).toBe("hello");

    resolve();
    await streamDone;
  });

  it("sendingRef prevents double-send even across session boundaries", async () => {
    let sendingRef = false;
    const calls: string[] = [];

    async function sendMessage(sessionId: string) {
      if (sendingRef) return;
      sendingRef = true;
      calls.push(sessionId);
      try {
        await Promise.resolve(); // simulate saveMessage
      } finally {
        sendingRef = false;
      }
    }

    // Rapid sends on different sessions
    const p1 = sendMessage("session-A");
    const p2 = sendMessage("session-B");
    await Promise.all([p1, p2]);

    // Only the first should execute
    expect(calls).toEqual(["session-A"]);

    // After completion, a new send works
    await sendMessage("session-B");
    expect(calls).toEqual(["session-A", "session-B"]);
  });

  it("cancel sets aborted flag on the correct session", () => {
    let streamState: StreamState | null = {
      sessionId: "session-A",
      aborted: false,
      activeStream: null,
    };

    // Cancel session A
    if (streamState?.sessionId === "session-A") {
      streamState.aborted = true;
    }

    expect(streamState.aborted).toBe(true);

    // Aborting a different session ID doesn't touch the state
    streamState = {
      sessionId: "session-B",
      aborted: false,
      activeStream: null,
    };

    if (streamState?.sessionId === "session-A") {
      streamState.aborted = true;
    }

    expect(streamState.aborted).toBe(false);
  });

  it("push handler skips stream events when local stream is active for that session", () => {
    let streamState: StreamState | null = {
      sessionId: "session-A",
      aborted: false,
      activeStream: null,
    };
    const pushHandled: string[] = [];

    function onPushEvent(sid: string, eventType: string) {
      // new_message is always handled
      if (eventType === "new_message") {
        pushHandled.push(`${sid}:${eventType}`);
        return;
      }

      // Skip stream events when local stream is active for this session
      if (streamState?.sessionId === sid) return;

      pushHandled.push(`${sid}:${eventType}`);
    }

    // Stream events for session A should be skipped (local stream handles them)
    onPushEvent("session-A", "token");
    onPushEvent("session-A", "done");
    expect(pushHandled).toEqual([]);

    // new_message always goes through
    onPushEvent("session-A", "new_message");
    expect(pushHandled).toEqual(["session-A:new_message"]);

    // Events for session B go through the push handler (no local stream for B)
    onPushEvent("session-B", "token");
    expect(pushHandled).toEqual(["session-A:new_message", "session-B:token"]);
  });

  it("stream cleanup only clears state for the matching session", () => {
    let streamState: StreamState | null = {
      sessionId: "session-A",
      aborted: false,
      activeStream: null,
    };

    // Imagine session A's stream finishes, but user already started session B's stream
    // (shouldn't happen since one stream at a time, but defensive)
    streamState = {
      sessionId: "session-B",
      aborted: false,
      activeStream: null,
    };

    // Session A's finally block tries to clean up — should NOT clear session B's state
    if (streamState?.sessionId === "session-A") {
      streamState = null;
    }

    expect(streamState).not.toBeNull();
    expect(streamState!.sessionId).toBe("session-B");
  });

  it("onToken callback is no-op after session switch (prevents message mixing)", () => {
    let sessionIdRef = "session-A";
    const messages: Array<{ id: string; content: string }> = [
      { id: "msg-B", content: "hello from session B" },
    ];

    // Simulate the onToken callback from streamTurn
    function onToken(sessionId: string, token: string, currentAssistantId: string) {
      if (sessionIdRef !== sessionId) return; // session guard
      const idx = messages.findIndex((m) => m.id === currentAssistantId);
      if (idx >= 0) {
        messages[idx] = { ...messages[idx], content: messages[idx].content + token };
      } else {
        // Create new message
        messages.push({ id: currentAssistantId, content: token });
      }
    }

    // Stream started on session A, then user switched to session B
    sessionIdRef = "session-B";

    // Tokens from session A's stream arrive — should be ignored
    onToken("session-A", " leaked token", "assistant-A");
    expect(messages).toEqual([{ id: "msg-B", content: "hello from session B" }]);
    // No assistant-A message leaked into session B
    expect(messages.find((m) => m.id === "assistant-A")).toBeUndefined();
  });

  it("onSnapshot callback is no-op after session switch", () => {
    let sessionIdRef = "session-A";
    const messages: Array<{ id: string; content: string }> = [];

    function onSnapshot(sessionId: string, assistantId: string, content: string) {
      if (sessionIdRef !== sessionId) return; // session guard
      messages.push({ id: assistantId, content });
    }

    // Switch to session B
    sessionIdRef = "session-B";

    // Snapshot from session A arrives — should be ignored
    onSnapshot("session-A", "assistant-A", "");
    expect(messages).toEqual([]);
  });

  it("onError callback is no-op after session switch (no ghost error messages)", () => {
    let sessionIdRef = "session-A";
    const messages: Array<{ id: string; role: string; content: string }> = [
      { id: "msg-B", role: "user", content: "question in session B" },
    ];

    function onError(sessionId: string, errorMessage: string) {
      if (sessionIdRef !== sessionId) return; // session guard
      messages.push({ id: `err-${Date.now()}`, role: "assistant", content: `Error: ${errorMessage}` });
    }

    // Switch to session B
    sessionIdRef = "session-B";

    // Error from session A arrives — should be ignored
    onError("session-A", "LLM API failed");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("question in session B");
  });

  it("empty snapshot defers message creation to first token", () => {
    const messages: Array<{ id: string; content: string; model?: string }> = [];
    let currentAssistantId = "";

    function onSnapshot(assistantId: string, content: string) {
      currentAssistantId = assistantId;
      // Don't create empty placeholder
      if (!content) return;
      messages.push({ id: assistantId, content });
    }

    function onToken(token: string, model: string) {
      const existing = messages.find((m) => m.id === currentAssistantId);
      if (existing) {
        existing.content += token;
      } else {
        // First token — create the message
        messages.push({ id: currentAssistantId, content: token, model });
      }
    }

    // Snapshot arrives with empty content
    onSnapshot("asst-1", "");
    expect(messages).toEqual([]); // No empty bubble

    // First token arrives — creates the message
    onToken("Hello", "gpt-4");
    expect(messages).toEqual([{ id: "asst-1", content: "Hello", model: "gpt-4" }]);

    // Subsequent tokens update normally
    onToken(" world", "gpt-4");
    expect(messages).toEqual([{ id: "asst-1", content: "Hello world", model: "gpt-4" }]);
  });

  it("tool-only response creates message on first onToolCall when snapshot was empty", () => {
    const messages: Array<{ id: string; content: string; toolCalls?: unknown[] }> = [];
    let currentAssistantId = "";
    const collectedToolCalls: unknown[] = [];

    function onSnapshot(assistantId: string, content: string) {
      currentAssistantId = assistantId;
      if (!content) return;
      messages.push({ id: assistantId, content });
    }

    function onToolCall(toolCall: { id: string; name: string }) {
      collectedToolCalls.push(toolCall);
      const existing = messages.find((m) => m.id === currentAssistantId);
      if (existing) {
        existing.toolCalls = [...collectedToolCalls];
      } else {
        // Create message on first tool call
        messages.push({ id: currentAssistantId, content: "", toolCalls: [...collectedToolCalls] });
      }
    }

    // Empty snapshot
    onSnapshot("asst-1", "");
    expect(messages).toEqual([]);

    // Tool call arrives — creates the message
    onToolCall({ id: "tc-1", name: "browser_navigate" });
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("asst-1");
    expect(messages[0].toolCalls).toHaveLength(1);
  });

  it("fetchMessages after stream skips update if session changed", async () => {
    let sessionIdRef = "session-A";
    let messages: string[] = [];

    async function sendAndFetch(sessionId: string) {
      // Simulate streaming
      await Promise.resolve();

      // After stream: guard fetchMessages
      if (sessionIdRef !== sessionId) return;

      // Simulate fetchMessages
      await Promise.resolve();

      // Guard again — session might have changed during fetch
      if (sessionIdRef !== sessionId) return;
      messages = [`fetched-${sessionId}`];
    }

    const p = sendAndFetch("session-A");

    // User switches mid-stream
    sessionIdRef = "session-B";
    messages = ["loaded-session-B"];

    await p;

    // Session B's messages should be untouched
    expect(messages).toEqual(["loaded-session-B"]);
  });
});
