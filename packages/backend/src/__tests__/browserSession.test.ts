import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ===========================================================================
// Per-session browser infrastructure tests
//
// These tests mock Xvfb/Chrome/x11vnc and verify:
// 1. Lazy creation on first browser tool use
// 2. Per-session isolation (different display numbers, VNC ports)
// 3. Idle timeout cleanup
// 4. Recreation after timeout
// 5. Session deletion cleanup
// ===========================================================================

// ---------------------------------------------------------------------------
// Mock external dependencies
// ---------------------------------------------------------------------------

vi.mock("../services/db.js", () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock("../services/sessionStore.js", () => ({
  getSession: vi.fn(),
  getSessionModel: vi.fn().mockResolvedValue("deepseek:deepseek-chat"),
  getSessionVisionModel: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/memoryStore.js", () => ({
  searchMemories: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/settingsStore.js", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  putSettings: vi.fn(),
}));

vi.mock("../services/sessionFiles.js", () => ({
  saveSessionFile: vi.fn().mockReturnValue("test-file.jpg"),
  getSessionFilePath: vi.fn(),
}));

vi.mock("../config/runtimeSettings.js", () => ({
  getAllRuntimeSettings: vi.fn().mockResolvedValue({}),
  getRuntimeSetting: vi.fn().mockResolvedValue(null),
}));

// Mock env with short idle timeout for testing
vi.mock("../config/env.js", () => ({
  env: {
    ANTHROPIC_API_KEY: "",
    GOOGLE_GEMINI_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    PORT: 0,
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    MEMORY_MAX_STORAGE_TOKENS: 200000,
    MEMORY_MAX_RETURN_TOKENS: 200000,
    VNC_COORDINATE_BACKEND: "vision",
    VNC_CONNECTION_TIMEOUT: 300,
    SHOWUI_API_URL: "",
    VISION_MODEL: "",
    BROWSER_WS_ENDPOINT: "",
    BROWSER_IDLE_TIMEOUT: 1, // 1 second for fast timeout tests
  },
}));

// ---------------------------------------------------------------------------
// Mock patchright (Playwright fork) — mock Browser, Context, Page, CDP
// ---------------------------------------------------------------------------

function createMockPage() {
  return {
    url: vi.fn().mockReturnValue("about:blank"),
    title: vi.fn().mockResolvedValue(""),
    goto: vi.fn().mockResolvedValue(null),
    evaluate: vi.fn().mockResolvedValue(null),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("")),
    isClosed: vi.fn().mockReturnValue(false),
    viewportSize: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
    mouse: {
      click: vi.fn(),
      wheel: vi.fn(),
      move: vi.fn(),
    },
    keyboard: {
      press: vi.fn(),
      type: vi.fn(),
    },
    on: vi.fn(),
  };
}

function createMockContext(page: ReturnType<typeof createMockPage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    newCDPSession: vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue({}),
      detach: vi.fn().mockResolvedValue(undefined),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockBrowser(context: ReturnType<typeof createMockContext>) {
  const disconnectHandlers: Array<() => void> = [];
  return {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "disconnected") disconnectHandlers.push(handler);
    }),
    _triggerDisconnect: () => disconnectHandlers.forEach((h) => h()),
  };
}

// Track launched instances for assertions
let launchedBrowsers: ReturnType<typeof createMockBrowser>[] = [];
let spawnedProcesses: Array<{ command: string; args: string[]; killed: boolean; exitCode: number | null }> = [];

vi.mock("patchright", () => ({
  chromium: {
    launch: vi.fn(async () => {
      const page = createMockPage();
      const ctx = createMockContext(page);
      const browser = createMockBrowser(ctx);
      launchedBrowsers.push(browser);
      return browser;
    }),
  },
}));

// Mock child_process.spawn — track spawned Xvfb and x11vnc processes
vi.mock("child_process", () => ({
  spawn: vi.fn((command: string, args: string[]) => {
    const proc = {
      command,
      args: [...args],
      killed: false,
      exitCode: null as number | null,
      on: vi.fn(),
      kill: vi.fn(function (this: typeof proc) {
        this.killed = true;
        this.exitCode = 0;
      }),
    };
    spawnedProcesses.push(proc);
    return proc;
  }),
}));

// Mock fs — track token file writes/deletes
let writtenFiles: Map<string, string> = new Map();
let deletedFiles: Set<string> = new Set();

vi.mock("fs", () => ({
  writeFileSync: vi.fn((path: string, content: string) => {
    writtenFiles.set(path, content);
  }),
  unlinkSync: vi.fn((path: string) => {
    deletedFiles.add(path);
  }),
  existsSync: vi.fn((path: string) => {
    // Simulate X display socket exists immediately
    if (path.startsWith("/tmp/.X11-unix/X")) return true;
    return writtenFiles.has(path);
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BrowserSessionManager — lazy creation", () => {
  let manager: typeof import("../services/tools/browser/BrowserSessionManager.js").browserSessionManager;

  beforeEach(async () => {
    launchedBrowsers = [];
    spawnedProcesses = [];
    writtenFiles = new Map();
    deletedFiles = new Set();
    vi.useFakeTimers();

    // Fresh import each test to reset the singleton
    vi.resetModules();
    const mod = await import("../services/tools/browser/BrowserSessionManager.js");
    manager = mod.browserSessionManager;
  });

  afterEach(async () => {
    await manager.destroyAll();
    vi.useRealTimers();
  });

  it("no browser infra exists until first getOrCreate", () => {
    expect(manager.getActiveSessions()).toEqual([]);
    expect(manager.has("session-A")).toBe(false);
    expect(manager.get("session-A")).toBeUndefined();
  });

  it("getOrCreate creates Xvfb, Chrome, x11vnc, and token file", async () => {
    const session = await manager.getOrCreate("session-A");

    expect(session.sessionId).toBe("session-A");
    expect(session.displayNum).toBeGreaterThanOrEqual(100);
    expect(session.vncPort).toBe(5900 + session.displayNum);

    // Xvfb was spawned
    const xvfb = spawnedProcesses.find((p) => p.command === "Xvfb");
    expect(xvfb).toBeDefined();
    expect(xvfb!.args).toContain(`:${session.displayNum}`);

    // Chrome was launched
    expect(launchedBrowsers).toHaveLength(1);

    // x11vnc was spawned
    const vnc = spawnedProcesses.find((p) => p.command === "x11vnc");
    expect(vnc).toBeDefined();
    expect(vnc!.args).toContain(`:${session.displayNum}`);
    expect(vnc!.args).toContain(String(session.vncPort));

    // Token file was written
    const tokenFile = Array.from(writtenFiles.entries()).find(([k]) => k.includes("session-A"));
    expect(tokenFile).toBeDefined();
    expect(tokenFile![1]).toContain(`localhost:${session.vncPort}`);
  });

  it("second getOrCreate for same session reuses existing infra", async () => {
    const session1 = await manager.getOrCreate("session-A");
    const session2 = await manager.getOrCreate("session-A");

    expect(session1).toBe(session2);
    expect(launchedBrowsers).toHaveLength(1); // Only one Chrome launched
  });

  it("two sessions get different display numbers and VNC ports", async () => {
    const sessionA = await manager.getOrCreate("session-A");
    const sessionB = await manager.getOrCreate("session-B");

    expect(sessionA.displayNum).not.toBe(sessionB.displayNum);
    expect(sessionA.vncPort).not.toBe(sessionB.vncPort);
    expect(launchedBrowsers).toHaveLength(2);
  });

  it("getActiveSessions returns all active session IDs", async () => {
    await manager.getOrCreate("session-A");
    await manager.getOrCreate("session-B");

    const active = manager.getActiveSessions();
    expect(active).toContain("session-A");
    expect(active).toContain("session-B");
    expect(active).toHaveLength(2);
  });
});

describe("BrowserSessionManager — idle timeout", () => {
  let manager: typeof import("../services/tools/browser/BrowserSessionManager.js").browserSessionManager;

  beforeEach(async () => {
    launchedBrowsers = [];
    spawnedProcesses = [];
    writtenFiles = new Map();
    deletedFiles = new Set();
    vi.useFakeTimers();

    vi.resetModules();
    const mod = await import("../services/tools/browser/BrowserSessionManager.js");
    manager = mod.browserSessionManager;
  });

  afterEach(async () => {
    await manager.destroyAll();
    vi.useRealTimers();
  });

  it("session is destroyed after idle timeout", async () => {
    await manager.getOrCreate("session-A");
    expect(manager.has("session-A")).toBe(true);

    // Advance past the 1-second timeout
    await vi.advanceTimersByTimeAsync(1500);

    expect(manager.has("session-A")).toBe(false);
    expect(manager.getActiveSessions()).not.toContain("session-A");
  });

  it("getOrCreate resets idle timer", async () => {
    await manager.getOrCreate("session-A");

    // Advance 800ms (not yet timed out)
    await vi.advanceTimersByTimeAsync(800);
    expect(manager.has("session-A")).toBe(true);

    // Touch (reset timer)
    await manager.getOrCreate("session-A");

    // Advance another 800ms (still within reset timeout)
    await vi.advanceTimersByTimeAsync(800);
    expect(manager.has("session-A")).toBe(true);

    // Now advance past the full timeout from last touch
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.has("session-A")).toBe(false);
  });

  it("only idle session is cleaned up — active sessions remain", async () => {
    await manager.getOrCreate("session-A");
    await manager.getOrCreate("session-B");

    // Touch session B to reset its timer
    await vi.advanceTimersByTimeAsync(800);
    await manager.getOrCreate("session-B");

    // Let session A time out
    await vi.advanceTimersByTimeAsync(500);

    expect(manager.has("session-A")).toBe(false);
    expect(manager.has("session-B")).toBe(true);
  });
});

describe("BrowserSessionManager — recreation after timeout", () => {
  let manager: typeof import("../services/tools/browser/BrowserSessionManager.js").browserSessionManager;

  beforeEach(async () => {
    launchedBrowsers = [];
    spawnedProcesses = [];
    writtenFiles = new Map();
    deletedFiles = new Set();
    vi.useFakeTimers();

    vi.resetModules();
    const mod = await import("../services/tools/browser/BrowserSessionManager.js");
    manager = mod.browserSessionManager;
  });

  afterEach(async () => {
    await manager.destroyAll();
    vi.useRealTimers();
  });

  it("after timeout, getOrCreate creates fresh infra", async () => {
    const first = await manager.getOrCreate("session-A");
    const firstDisplayNum = first.displayNum;

    // Wait for timeout
    await vi.advanceTimersByTimeAsync(1500);
    expect(manager.has("session-A")).toBe(false);

    // Recreate
    const second = await manager.getOrCreate("session-A");
    expect(second).not.toBe(first);
    expect(manager.has("session-A")).toBe(true);

    // Should have launched 2 browsers total
    expect(launchedBrowsers).toHaveLength(2);

    // The recreated session has a clean state
    expect(second.elementMap.size).toBe(0);
    expect(second.cdpSession).toBeNull();
    expect(second.mapVersion).toBe(0);
  });
});

describe("BrowserSessionManager — destroy", () => {
  let manager: typeof import("../services/tools/browser/BrowserSessionManager.js").browserSessionManager;

  beforeEach(async () => {
    launchedBrowsers = [];
    spawnedProcesses = [];
    writtenFiles = new Map();
    deletedFiles = new Set();
    vi.useFakeTimers();

    vi.resetModules();
    const mod = await import("../services/tools/browser/BrowserSessionManager.js");
    manager = mod.browserSessionManager;
  });

  afterEach(async () => {
    await manager.destroyAll();
    vi.useRealTimers();
  });

  it("destroy kills all processes and removes token file", async () => {
    await manager.getOrCreate("session-A");

    await manager.destroy("session-A");

    // Browser should have been closed
    expect(launchedBrowsers[0].close).toHaveBeenCalled();

    // Xvfb and x11vnc should have been killed
    const xvfb = spawnedProcesses.find((p) => p.command === "Xvfb");
    const vnc = spawnedProcesses.find((p) => p.command === "x11vnc");
    expect(xvfb!.killed).toBe(true);
    expect(vnc!.killed).toBe(true);

    // Token file should have been deleted
    const tokenDeleted = Array.from(deletedFiles).find((f) => f.includes("session-A"));
    expect(tokenDeleted).toBeDefined();

    // Session should be removed
    expect(manager.has("session-A")).toBe(false);
  });

  it("destroy is safe to call on non-existent session", async () => {
    await expect(manager.destroy("nonexistent")).resolves.not.toThrow();
  });

  it("destroying one session does not affect others", async () => {
    await manager.getOrCreate("session-A");
    await manager.getOrCreate("session-B");

    await manager.destroy("session-A");

    expect(manager.has("session-A")).toBe(false);
    expect(manager.has("session-B")).toBe(true);

    // Only 1 of 2 browsers should have been closed
    expect(launchedBrowsers[0].close).toHaveBeenCalled();
    expect(launchedBrowsers[1].close).not.toHaveBeenCalled();
  });

  it("destroyAll cleans up everything", async () => {
    await manager.getOrCreate("session-A");
    await manager.getOrCreate("session-B");
    await manager.getOrCreate("session-C");

    await manager.destroyAll();

    expect(manager.getActiveSessions()).toEqual([]);
    expect(launchedBrowsers.every((b) => b.close.mock.calls.length > 0)).toBe(true);
  });
});

describe("BrowserSessionManager — per-session element map isolation", () => {
  let updateElementMap: typeof import("../services/tools/browser/connection.js").updateElementMap;
  let resolveElement: typeof import("../services/tools/browser/connection.js").resolveElement;
  let clearElementMap: typeof import("../services/tools/browser/connection.js").clearElementMap;
  let ElementNotFoundError: typeof import("../services/tools/browser/connection.js").ElementNotFoundError;
  let manager: typeof import("../services/tools/browser/BrowserSessionManager.js").browserSessionManager;

  beforeEach(async () => {
    launchedBrowsers = [];
    spawnedProcesses = [];
    writtenFiles = new Map();
    deletedFiles = new Set();
    vi.useFakeTimers();

    vi.resetModules();
    const connMod = await import("../services/tools/browser/connection.js");
    updateElementMap = connMod.updateElementMap;
    resolveElement = connMod.resolveElement;
    clearElementMap = connMod.clearElementMap;
    ElementNotFoundError = connMod.ElementNotFoundError;

    const mgrMod = await import("../services/tools/browser/BrowserSessionManager.js");
    manager = mgrMod.browserSessionManager;
  });

  afterEach(async () => {
    await manager.destroyAll();
    vi.useRealTimers();
  });

  it("element maps are isolated per session", async () => {
    await manager.getOrCreate("session-A");
    await manager.getOrCreate("session-B");

    const elementsA = new Map([
      [0, { role: "button", name: "Submit", backendDOMNodeId: 100, mapVersion: 0 }],
    ]);
    const elementsB = new Map([
      [0, { role: "link", name: "Home", backendDOMNodeId: 200, mapVersion: 0 }],
    ]);

    updateElementMap("session-A", elementsA);
    updateElementMap("session-B", elementsB);

    const elA = resolveElement("session-A", 0);
    const elB = resolveElement("session-B", 0);

    expect(elA.role).toBe("button");
    expect(elA.name).toBe("Submit");
    expect(elB.role).toBe("link");
    expect(elB.name).toBe("Home");
  });

  it("resolveElement for one session's ID fails for another session", async () => {
    await manager.getOrCreate("session-A");
    await manager.getOrCreate("session-B");

    const elements = new Map([
      [42, { role: "textbox", name: "Search", backendDOMNodeId: 999, mapVersion: 0 }],
    ]);
    updateElementMap("session-A", elements);

    // Session A can resolve it
    expect(resolveElement("session-A", 42).name).toBe("Search");

    // Session B cannot
    expect(() => resolveElement("session-B", 42)).toThrow(ElementNotFoundError);
  });

  it("clearElementMap only affects the specified session", async () => {
    await manager.getOrCreate("session-A");
    await manager.getOrCreate("session-B");

    const elementsA = new Map([
      [0, { role: "button", name: "A", backendDOMNodeId: 1, mapVersion: 0 }],
    ]);
    const elementsB = new Map([
      [0, { role: "button", name: "B", backendDOMNodeId: 2, mapVersion: 0 }],
    ]);
    updateElementMap("session-A", elementsA);
    updateElementMap("session-B", elementsB);

    clearElementMap("session-A");

    expect(() => resolveElement("session-A", 0)).toThrow(ElementNotFoundError);
    expect(resolveElement("session-B", 0).name).toBe("B");
  });
});

describe("BrowserService cache — cleanup on session delete", () => {
  it("cleanupBrowserServiceCache removes entries for a session", async () => {
    vi.resetModules();
    const { getBrowserService, cleanupBrowserServiceCache } = await import(
      "../services/tools/browser/BrowserService.js"
    );

    const service = getBrowserService({
      sessionId: "session-A",
      model: "model-1",
      provider: "provider-1",
    });

    // Service should be cached
    const cached = getBrowserService({
      sessionId: "session-A",
      model: "model-1",
      provider: "provider-1",
    });
    expect(cached).toBe(service);

    // Clean up
    cleanupBrowserServiceCache("session-A");

    // Should get a new instance
    const newService = getBrowserService({
      sessionId: "session-A",
      model: "model-1",
      provider: "provider-1",
    });
    expect(newService).not.toBe(service);
  });

  it("cleanupBrowserServiceCache does not affect other sessions", async () => {
    vi.resetModules();
    const { getBrowserService, cleanupBrowserServiceCache } = await import(
      "../services/tools/browser/BrowserService.js"
    );

    const serviceA = getBrowserService({
      sessionId: "session-A",
      model: "model-1",
      provider: "provider-1",
    });
    const serviceB = getBrowserService({
      sessionId: "session-B",
      model: "model-1",
      provider: "provider-1",
    });

    cleanupBrowserServiceCache("session-A");

    // B should still be cached
    const cachedB = getBrowserService({
      sessionId: "session-B",
      model: "model-1",
      provider: "provider-1",
    });
    expect(cachedB).toBe(serviceB);
  });
});
