import { describe, it, expect, beforeEach } from "vitest";

/**
 * Tests for cross-client settings synchronization.
 *
 * When one client changes a setting (e.g., default model), all other clients
 * should update via `settings_changed` push. If a client misses the push
 * (e.g., WS disconnect while mobile is backgrounded), it must re-fetch
 * settings on reconnect to avoid stale state.
 *
 * We simulate the control-flow patterns used in useSettings and useModels
 * without rendering React hooks.
 */

// ---------------------------------------------------------------------------
// Simulated WS infrastructure (mirrors wsClient push + connection listeners)
// ---------------------------------------------------------------------------

let connected: boolean;
let pushListeners: Map<string, Set<(event: unknown) => void>>;
let connectionListeners: Set<(connected: boolean) => void>;

function registerPushListener(channel: string, cb: (event: unknown) => void) {
  let set = pushListeners.get(channel);
  if (!set) {
    set = new Set();
    pushListeners.set(channel, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

function registerConnectionListener(cb: (connected: boolean) => void) {
  connectionListeners.add(cb);
  return () => {
    connectionListeners.delete(cb);
  };
}

function simulateDisconnect() {
  connected = false;
  for (const cb of connectionListeners) cb(false);
}

function simulateReconnect() {
  connected = true;
  for (const cb of connectionListeners) cb(true);
}

/** Broadcast to push listeners (only if "connected" — simulates server push). */
function broadcastGlobal(channel: string, event: unknown) {
  if (!connected) return;
  const listeners = pushListeners.get(channel);
  if (listeners) {
    for (const cb of listeners) cb(event);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("settings cross-client sync — model selection", () => {
  let settings: Record<string, string>;
  let serverSettings: Record<string, string>;
  let fetchCount: number;

  async function fetchSettingsFromServer() {
    fetchCount++;
    return { ...serverSettings };
  }

  beforeEach(() => {
    serverSettings = { default_model: "gpt-4" };
    settings = { ...serverSettings };
    fetchCount = 0;
    connected = true;
    pushListeners = new Map();
    connectionListeners = new Set();
  });

  /**
   * Simulates the CURRENT (buggy) useSettings pattern:
   * - Fetches once on mount
   * - Listens for settings_changed pushes
   * - NO re-fetch on reconnect
   */
  async function setupBuggyUseSettings() {
    settings = await fetchSettingsFromServer();

    registerPushListener("__settings__", (event: unknown) => {
      const e = event as { type: string; data: Record<string, string> };
      if (e.type === "settings_changed") {
        settings = e.data;
      }
    });

    // Bug: no onConnectionChange listener
  }

  /**
   * Simulates the FIXED useSettings pattern:
   * - Fetches once on mount
   * - Listens for settings_changed pushes
   * - Re-fetches on reconnect
   */
  async function setupFixedUseSettings() {
    settings = await fetchSettingsFromServer();

    registerPushListener("__settings__", (event: unknown) => {
      const e = event as { type: string; data: Record<string, string> };
      if (e.type === "settings_changed") {
        settings = e.data;
      }
    });

    // Fix: re-fetch on reconnect
    registerConnectionListener((conn) => {
      if (conn) {
        fetchSettingsFromServer().then((s) => {
          settings = s;
        });
      }
    });
  }

  it("push event updates settings when client is connected", async () => {
    await setupBuggyUseSettings();

    expect(settings.default_model).toBe("gpt-4");

    // Another client changes model
    serverSettings = { default_model: "claude-3" };
    broadcastGlobal("__settings__", {
      type: "settings_changed",
      data: serverSettings,
    });

    expect(settings.default_model).toBe("claude-3");
  });

  it("settings become stale when push is missed during disconnect (bug)", async () => {
    await setupBuggyUseSettings();

    expect(settings.default_model).toBe("gpt-4");

    // Mobile goes to background — WS disconnects
    simulateDisconnect();

    // While disconnected, desktop changes the model
    serverSettings = { default_model: "claude-3" };
    broadcastGlobal("__settings__", {
      type: "settings_changed",
      data: serverSettings,
    });

    // Mobile reconnects
    simulateReconnect();
    await Promise.resolve();

    // BUG: settings are stale because the push was missed and no re-fetch happened
    expect(settings.default_model).toBe("gpt-4");
  });

  it("re-fetch on reconnect compensates for missed push (fix)", async () => {
    await setupFixedUseSettings();

    expect(settings.default_model).toBe("gpt-4");
    const initialFetchCount = fetchCount;

    // Mobile goes to background
    simulateDisconnect();

    // Desktop changes the model
    serverSettings = { default_model: "claude-3" };
    broadcastGlobal("__settings__", {
      type: "settings_changed",
      data: serverSettings,
    });

    // Mobile reconnects — triggers re-fetch
    simulateReconnect();
    await Promise.resolve();

    expect(settings.default_model).toBe("claude-3");
    expect(fetchCount).toBe(initialFetchCount + 1);
  });

  it("model selection propagates through the full chain", async () => {
    // Full chain: settings.default_model → useModels defaultModelId → selectedModel
    const models = [
      { id: "gpt-4", name: "GPT-4" },
      { id: "claude-3", name: "Claude 3" },
      { id: "deepseek", name: "DeepSeek" },
    ];
    let selectedModel = models[0];

    // Simulate useModels effect
    function syncModelFromSettings() {
      const defaultModelId = settings.default_model;
      if (!defaultModelId) return;
      const match = models.find((m) => m.id === defaultModelId);
      if (match && match.id !== selectedModel.id) {
        selectedModel = match;
      }
    }

    await setupFixedUseSettings();
    syncModelFromSettings();
    expect(selectedModel.id).toBe("gpt-4");

    // Desktop changes model while mobile is disconnected
    simulateDisconnect();
    serverSettings = { default_model: "deepseek" };
    broadcastGlobal("__settings__", {
      type: "settings_changed",
      data: serverSettings,
    });

    // Mobile reconnects — re-fetch updates settings
    simulateReconnect();
    await Promise.resolve();

    // Re-run the useModels effect (triggered by settings.default_model change)
    syncModelFromSettings();

    expect(selectedModel.id).toBe("deepseek");
    expect(selectedModel.name).toBe("DeepSeek");
  });

  it("push arriving after reconnect re-fetch applies newer data", async () => {
    // Re-fetch resolves first, then a push arrives with newer data.
    // The push should overwrite the re-fetch result.
    await setupFixedUseSettings();

    simulateDisconnect();
    serverSettings = { default_model: "claude-3" };
    simulateReconnect();

    // Re-fetch resolves with "claude-3"
    await Promise.resolve();
    expect(settings.default_model).toBe("claude-3");

    // Then another client changes the model — push arrives
    serverSettings = { default_model: "deepseek" };
    broadcastGlobal("__settings__", {
      type: "settings_changed",
      data: { default_model: "deepseek" },
    });

    expect(settings.default_model).toBe("deepseek");
  });

  it("multiple rapid reconnections don't cause duplicate fetches to race", async () => {
    await setupFixedUseSettings();
    const initialFetchCount = fetchCount;

    // Rapid disconnect/reconnect cycle
    simulateDisconnect();
    simulateReconnect();
    simulateDisconnect();
    simulateReconnect();
    await Promise.resolve();

    // Each reconnect triggers one fetch
    expect(fetchCount).toBe(initialFetchCount + 2);
    // But the settings should reflect the latest server state
    expect(settings.default_model).toBe("gpt-4");

    // Now change server settings and reconnect once more
    serverSettings = { default_model: "claude-3" };
    simulateDisconnect();
    simulateReconnect();
    await Promise.resolve();

    expect(settings.default_model).toBe("claude-3");
  });
});

describe("session cross-client sync — auto-approve", () => {
  interface Session {
    id: string;
    title: string;
    autoApprove: boolean;
  }

  let sessions: Session[];
  let serverSessions: Session[];
  let fetchCount: number;

  async function fetchSessionsFromServer() {
    fetchCount++;
    return serverSessions.map((s) => ({ ...s }));
  }

  beforeEach(() => {
    serverSessions = [
      { id: "s1", title: "Chat 1", autoApprove: false },
      { id: "s2", title: "Chat 2", autoApprove: false },
    ];
    sessions = serverSessions.map((s) => ({ ...s }));
    fetchCount = 0;
    connected = true;
    pushListeners = new Map();
    connectionListeners = new Set();
  });

  /**
   * Simulates the useSessions pattern (currently no reconnect re-fetch).
   */
  async function setupUseSessions(withReconnect: boolean) {
    sessions = await fetchSessionsFromServer();

    registerPushListener("__sessions__", (event: unknown) => {
      const e = event as { type: string; data: Session };
      if (e.type === "session_updated") {
        sessions = sessions.map((s) =>
          s.id === e.data.id ? e.data : s,
        );
      }
    });

    if (withReconnect) {
      registerConnectionListener((conn) => {
        if (conn) {
          fetchSessionsFromServer().then((s) => {
            sessions = s;
          });
        }
      });
    }
  }

  it("session_updated push propagates auto-approve change to other clients", async () => {
    await setupUseSessions(false);

    expect(sessions.find((s) => s.id === "s1")!.autoApprove).toBe(false);

    // Desktop toggles auto-approve for session s1
    serverSessions[0].autoApprove = true;
    broadcastGlobal("__sessions__", {
      type: "session_updated",
      data: { ...serverSessions[0] },
    });

    expect(sessions.find((s) => s.id === "s1")!.autoApprove).toBe(true);
    // Other session untouched
    expect(sessions.find((s) => s.id === "s2")!.autoApprove).toBe(false);
  });

  it("auto-approve change missed during disconnect leaves stale state (bug)", async () => {
    await setupUseSessions(false);

    simulateDisconnect();

    serverSessions[0].autoApprove = true;
    broadcastGlobal("__sessions__", {
      type: "session_updated",
      data: { ...serverSessions[0] },
    });

    simulateReconnect();
    await Promise.resolve();

    // BUG: session still shows autoApprove=false
    expect(sessions.find((s) => s.id === "s1")!.autoApprove).toBe(false);
  });

  it("re-fetch on reconnect updates auto-approve (fix)", async () => {
    await setupUseSessions(true);
    const initialFetchCount = fetchCount;

    simulateDisconnect();

    serverSessions[0].autoApprove = true;
    broadcastGlobal("__sessions__", {
      type: "session_updated",
      data: { ...serverSessions[0] },
    });

    simulateReconnect();
    await Promise.resolve();

    expect(sessions.find((s) => s.id === "s1")!.autoApprove).toBe(true);
    expect(fetchCount).toBe(initialFetchCount + 1);
  });

  it("optimistic auto-approve toggle updates local state immediately", async () => {
    await setupUseSessions(false);

    // Simulate setSessionAutoApprove: optimistic update
    const id = "s1";
    sessions = sessions.map((s) =>
      s.id === id ? { ...s, autoApprove: true } : s,
    );

    expect(sessions.find((s) => s.id === "s1")!.autoApprove).toBe(true);
  });

  it("session_updated push reconciles optimistic toggle from another client", async () => {
    await setupUseSessions(false);

    // Client A optimistically toggles auto-approve
    sessions = sessions.map((s) =>
      s.id === "s1" ? { ...s, autoApprove: true } : s,
    );

    // Meanwhile client B sets auto-approve to false (server broadcasts)
    serverSessions[0].autoApprove = false;
    broadcastGlobal("__sessions__", {
      type: "session_updated",
      data: { ...serverSessions[0] },
    });

    // Push reconciles: server's value wins
    expect(sessions.find((s) => s.id === "s1")!.autoApprove).toBe(false);
  });
});
