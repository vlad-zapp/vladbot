import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const mockCDPSession = {
  send: vi.fn(),
  detach: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

const mockPage = {
  goto: vi.fn(),
  url: vi.fn().mockReturnValue("https://example.com"),
  title: vi.fn().mockResolvedValue("Example"),
  screenshot: vi.fn().mockResolvedValue(Buffer.from("fakejpeg")),
  $: vi.fn(),
  // Default evaluate mock: returns 1080 for window.innerHeight, 0 for window.scrollY
  evaluate: vi.fn().mockImplementation((fnOrStr: unknown) => {
    if (typeof fnOrStr === "function") {
      const fnStr = fnOrStr.toString();
      if (fnStr.includes("innerHeight")) return Promise.resolve(1080);
      if (fnStr.includes("scrollY")) return Promise.resolve(0);
    }
    return Promise.resolve(undefined);
  }),
  viewportSize: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
  isClosed: vi.fn().mockReturnValue(false),
  on: vi.fn(),
  off: vi.fn(),
  waitForLoadState: vi.fn().mockResolvedValue(undefined),
  mouse: {
    click: vi.fn().mockResolvedValue(undefined),
    wheel: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
  },
  keyboard: {
    type: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
  },
};

const mockContext = {
  pages: vi.fn().mockReturnValue([]),
  newPage: vi.fn().mockResolvedValue(mockPage),
  newCDPSession: vi.fn().mockResolvedValue(mockCDPSession),
};

const mockBrowser = {
  isConnected: vi.fn().mockReturnValue(true),
  contexts: vi.fn().mockReturnValue([]),
  newContext: vi.fn().mockResolvedValue(mockContext),
  on: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockChromium = {
  launch: vi.fn().mockResolvedValue(mockBrowser),
  connect: vi.fn().mockResolvedValue(mockBrowser),
  connectOverCDP: vi.fn().mockResolvedValue(mockBrowser),
};

vi.mock("patchright", () => ({
  chromium: mockChromium,
}));

// Mock child_process for Xvfb and x11vnc spawning
const mockChildProcess = {
  exitCode: null as number | null,
  kill: vi.fn(),
  on: vi.fn(),
  pid: 12345,
};

vi.mock("child_process", () => ({
  spawn: vi.fn().mockReturnValue(mockChildProcess),
}));

// Mock fs for display socket detection and token files
vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("../config/env.js", () => ({
  env: {
    BROWSER_IDLE_TIMEOUT: 0,
  },
}));

const mockSaveSessionFile = vi.fn().mockReturnValue("1234-abcd.jpg");

vi.mock("../services/sessionFiles.js", () => ({
  saveSessionFile: (...args: unknown[]) => mockSaveSessionFile(...args),
}));

// Mock database to avoid real DB connections
vi.mock("../services/db.js", () => ({
  default: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

// Mock sessionStore for BrowserService
vi.mock("../services/sessionStore.js", () => ({
  getSessionModel: vi.fn().mockResolvedValue("deepseek:deepseek-chat"),
}));

// Mock settingsStore for BrowserService
vi.mock("../services/settingsStore.js", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

// --- CDP mock data ---

function makeSampleAXNodes() {
  return [
    {
      nodeId: "1",
      ignored: false,
      role: { type: "role", value: "document" },
      name: { type: "computedString", value: "Test Page" },
      childIds: ["2", "3", "4", "5"],
      backendDOMNodeId: 1,
    },
    {
      nodeId: "2",
      ignored: false,
      role: { type: "role", value: "heading" },
      name: { type: "computedString", value: "Welcome" },
      properties: [{ name: "level", value: { type: "integer", value: 1 } }],
      parentId: "1",
      childIds: [],
      backendDOMNodeId: 2,
    },
    {
      nodeId: "3",
      ignored: false,
      role: { type: "role", value: "textbox" },
      name: { type: "computedString", value: "Email" },
      value: { type: "string", value: "" },
      parentId: "1",
      childIds: [],
      backendDOMNodeId: 3,
    },
    {
      nodeId: "4",
      ignored: false,
      role: { type: "role", value: "button" },
      name: { type: "computedString", value: "Submit" },
      parentId: "1",
      childIds: [],
      backendDOMNodeId: 4,
    },
    {
      nodeId: "5",
      ignored: true,
      role: { type: "role", value: "generic" },
      parentId: "1",
      childIds: [],
      backendDOMNodeId: 5,
    },
  ];
}

const SAMPLE_BOX_MODEL = {
  model: {
    content: [100, 100, 200, 100, 200, 130, 100, 130],
    padding: [98, 98, 202, 98, 202, 132, 98, 132],
    border: [96, 96, 204, 96, 204, 134, 96, 134],
    margin: [86, 86, 214, 86, 214, 144, 86, 144],
    width: 100,
    height: 30,
  },
};

function setupCDPMock(overrides: Record<string, unknown> = {}) {
  mockCDPSession.send.mockImplementation((method: string) => {
    if (method in overrides) return Promise.resolve(overrides[method]);
    switch (method) {
      case "Accessibility.enable":
        return Promise.resolve({});
      case "Accessibility.getFullAXTree":
        return Promise.resolve({ nodes: makeSampleAXNodes() });
      case "Page.getFrameTree":
        return Promise.resolve({
          frameTree: { frame: { id: "main", url: "https://example.com" }, childFrames: [] },
        });
      case "DOM.getBoxModel":
        return Promise.resolve(SAMPLE_BOX_MODEL);
      case "DOM.scrollIntoViewIfNeeded":
        return Promise.resolve({});
      // For scrollElementIntoView and verifyElementExists
      case "DOM.resolveNode":
        return Promise.resolve({ object: { objectId: "mock-obj-123" } });
      case "Runtime.callFunctionOn":
        // Return viewport rect for getBoundingClientRect call
        return Promise.resolve({
          result: { value: { top: 100, bottom: 130, left: 100, right: 200, height: 30 } },
        });
      case "Runtime.releaseObject":
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  });
}

// --- Dynamic imports after mocks ---

const { browserTool } = await import("../services/tools/browser/index.js");
const { navigate } = await import(
  "../services/tools/browser/operations/navigate.js"
);
const { screenshot } = await import(
  "../services/tools/browser/operations/screenshot.js"
);
const { getContent } = await import(
  "../services/tools/browser/operations/getContent.js"
);
const { click } = await import(
  "../services/tools/browser/operations/click.js"
);
const { typeText } = await import(
  "../services/tools/browser/operations/type.js"
);
const { pressKey } = await import(
  "../services/tools/browser/operations/press.js"
);
const { scroll } = await import(
  "../services/tools/browser/operations/scroll.js"
);
const { executeJs } = await import(
  "../services/tools/browser/operations/executeJs.js"
);
const { getText } = await import(
  "../services/tools/browser/operations/getText.js"
);
const { getBrowserPage, isBrowserConnected, disconnectBrowser, reconnectBrowser, clearElementMap, cleanupBrowserSession } = await import(
  "../services/tools/browser/connection.js"
);
const { browserSessionManager } = await import(
  "../services/tools/browser/BrowserSessionManager.js"
);

// --- Helpers ---

const SID = "test-session";
const validate = (args: Record<string, unknown>) => browserTool.validate!(args);

beforeEach(async () => {
  await browserSessionManager.destroyAll();
  vi.clearAllMocks();
  mockChildProcess.exitCode = null;
  mockPage.url.mockReturnValue("https://example.com");
  mockPage.title.mockResolvedValue("Example");
  mockPage.screenshot.mockResolvedValue(Buffer.from("fakejpeg"));
  mockPage.viewportSize.mockReturnValue({ width: 1920, height: 1080 });
  mockPage.isClosed.mockReturnValue(false);
  mockPage.waitForLoadState.mockResolvedValue(undefined);
  mockBrowser.isConnected.mockReturnValue(true);
  mockBrowser.contexts.mockReturnValue([]);
  mockBrowser.newContext.mockResolvedValue(mockContext);
  mockBrowser.close.mockResolvedValue(undefined);
  mockContext.newPage.mockResolvedValue(mockPage);
  mockContext.newCDPSession.mockResolvedValue(mockCDPSession);
  mockCDPSession.detach.mockResolvedValue(undefined);
  setupCDPMock();
});

// =====================
// Tool definition tests
// =====================

describe("browserTool definition", () => {
  it("has correct name", () => {
    expect(browserTool.definition.name).toBe("browser");
  });

  it("has all expected operations", () => {
    const ops = Object.keys(browserTool.definition.operations);
    expect(ops).toContain("connect");
    expect(ops).toContain("disconnect");
    expect(ops).toContain("navigate");
    expect(ops).toContain("screenshot");
    expect(ops).toContain("describe");
    expect(ops).toContain("find_all");
    expect(ops).toContain("click");
    expect(ops).toContain("type");
    expect(ops).toContain("press");
    expect(ops).toContain("scroll");
  });

  it("does not have the old get_content operation (replaced by describe/find)", () => {
    const ops = Object.keys(browserTool.definition.operations);
    expect(ops).not.toContain("get_content");
    expect(ops).not.toContain("get_text");
  });

  it("does not have search_dom operation (removed)", () => {
    const ops = Object.keys(browserTool.definition.operations);
    expect(ops).not.toContain("search_dom");
  });

  it("navigate operation requires url", () => {
    const nav = browserTool.definition.operations.navigate;
    expect(nav.required).toContain("url");
    expect(nav.params.url).toBeDefined();
  });

  it("type operation has text, element, clear_first params (requires text)", () => {
    const t = browserTool.definition.operations.type;
    expect(t.required).toContain("text");
    expect(t.params.text).toBeDefined();
    expect(t.params.element).toBeDefined();
    expect(t.params.clear_first).toBeDefined();
    // press_enter removed - use press operation instead
    expect(t.params.press_enter).toBeUndefined();
    // selector removed - must use element index from get_content
    expect(t.params.selector).toBeUndefined();
  });

  it("press operation requires key", () => {
    const p = browserTool.definition.operations.press;
    expect(p.required).toContain("key");
    expect(p.params.key).toBeDefined();
  });

  it("click operation requires element (no x/y or selector)", () => {
    const c = browserTool.definition.operations.click;
    expect(c.params.element).toBeDefined();
    // x/y coordinates removed - must use element ID from describe/find
    expect(c.params.x).toBeUndefined();
    expect(c.params.y).toBeUndefined();
    expect(c.params.selector).toBeUndefined();
    expect(c.required).toContain("element");
  });

  it("scroll operation has direction, amount, to_element params", () => {
    const s = browserTool.definition.operations.scroll;
    expect(s.params.direction).toBeDefined();
    expect(s.params.amount).toBeDefined();
    expect(s.params.to_element).toBeDefined();
  });

  it("describe operation has optional question param", () => {
    const desc = browserTool.definition.operations.describe;
    expect(desc.params.question).toBeDefined();
    expect(desc.required ?? []).not.toContain("question");
  });

  it("find_all operation requires query param", () => {
    const find = browserTool.definition.operations.find_all;
    expect(find.required).toContain("query");
  });

  it("screenshot operation has optional selector param", () => {
    const ss = browserTool.definition.operations.screenshot;
    expect(ss.params.selector).toBeDefined();
    expect(ss.required ?? []).not.toContain("selector");
  });

  it("connect accepts address param, disconnect has no params", () => {
    expect(Object.keys(browserTool.definition.operations.connect.params)).toHaveLength(1);
    expect(browserTool.definition.operations.connect.params).toHaveProperty("address");
    expect(Object.keys(browserTool.definition.operations.disconnect.params)).toHaveLength(0);
  });
});

// ================
// Validation tests
// ================

describe("browserTool.validate", () => {
  it("navigate with valid URL is valid", () => {
    expect(validate({ operation: "navigate", url: "https://example.com" })).toEqual({
      valid: true,
    });
  });

  it("navigate without url returns error", () => {
    const result = validate({ operation: "navigate" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("url");
  });

  it("navigate with invalid URL returns error", () => {
    const result = validate({ operation: "navigate", url: "not-a-url" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid URL");
  });

  it("connect is valid with no args", () => {
    expect(validate({ operation: "connect" })).toEqual({ valid: true });
  });

  it("disconnect is valid with no args", () => {
    expect(validate({ operation: "disconnect" })).toEqual({ valid: true });
  });

  it("screenshot is valid with no args", () => {
    expect(validate({ operation: "screenshot" })).toEqual({ valid: true });
  });

  it("screenshot with selector is valid", () => {
    expect(validate({ operation: "screenshot", selector: "#main" })).toEqual({
      valid: true,
    });
  });

  it("get_content is valid with no args", () => {
    expect(validate({ operation: "get_content" })).toEqual({ valid: true });
  });

  it("get_content with mode is valid", () => {
    expect(
      validate({ operation: "get_content", mode: "dom" }),
    ).toEqual({ valid: true });
  });

  it("type without text returns error", () => {
    const result = validate({ operation: "type" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("text");
  });

  it("type with text is valid", () => {
    expect(validate({ operation: "type", text: "hello" })).toEqual({
      valid: true,
    });
  });

  it("press without key returns error", () => {
    const result = validate({ operation: "press" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("key");
  });

  it("press with key is valid", () => {
    expect(validate({ operation: "press", key: "Enter" })).toEqual({
      valid: true,
    });
  });

  it("click with element is valid", () => {
    expect(validate({ operation: "click", element: 42 })).toEqual({
      valid: true,
    });
  });

  it("click without element returns error", () => {
    const result = validate({ operation: "click" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("element");
  });

  it("scroll is valid with no args", () => {
    expect(validate({ operation: "scroll" })).toEqual({ valid: true });
  });
});

// ======================
// Navigate operation test
// ======================

describe("navigate", () => {
  it("calls page.goto and returns result", async () => {
    const mockResponse = { status: () => 200 };
    mockPage.goto.mockResolvedValue(mockResponse);
    mockPage.url.mockReturnValue("https://example.com/");
    mockPage.title.mockResolvedValue("Example Domain");

    const raw = await navigate({ url: "https://example.com" }, SID);
    const result = JSON.parse(raw);

    expect(result.type).toBe("browser_navigate");
    expect(result.url).toBe("https://example.com/");
    expect(result.title).toBe("Example Domain");
    expect(result.status).toBe(200);

    expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  });

  it("uses custom wait_until", async () => {
    mockPage.goto.mockResolvedValue({ status: () => 200 });

    await navigate({ url: "https://example.com", wait_until: "networkidle" }, SID);

    expect(mockPage.goto).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ waitUntil: "networkidle" }),
    );
  });

  it("throws on missing url", async () => {
    await expect(navigate({}, SID)).rejects.toThrow("Missing required argument: url");
  });

  it("throws on invalid wait_until", async () => {
    await expect(
      navigate({ url: "https://example.com", wait_until: "bogus" }, SID),
    ).rejects.toThrow("Invalid wait_until value");
  });

  it("returns null status when response is null", async () => {
    mockPage.goto.mockResolvedValue(null);

    const raw = await navigate({ url: "https://example.com" }, SID);
    const result = JSON.parse(raw);

    expect(result.status).toBeNull();
  });
});

// ========================
// Screenshot operation test
// ========================

describe("screenshot", () => {
  it("takes full-page screenshot and saves to session file", async () => {
    const raw = await screenshot({}, "session-123");
    const result = JSON.parse(raw);

    expect(result.type).toBe("browser_screenshot");
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.image_url).toBe("/api/sessions/session-123/files/1234-abcd.jpg");
    expect(result.image_base64).toBeUndefined();

    expect(mockPage.screenshot).toHaveBeenCalledWith({
      type: "jpeg",
      quality: 75,
    });
    expect(mockSaveSessionFile).toHaveBeenCalledWith(
      "session-123",
      expect.any(Buffer),
      "jpg",
    );
  });

  it("returns base64 when no sessionId", async () => {
    const raw = await screenshot({});
    const result = JSON.parse(raw);

    expect(result.image_base64).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.image_url).toBeUndefined();
    expect(mockSaveSessionFile).not.toHaveBeenCalled();
  });

  it("takes element screenshot when selector is provided", async () => {
    const mockElement = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from("element-jpeg")),
    };
    mockPage.$.mockResolvedValue(mockElement);

    const raw = await screenshot({ selector: "#hero" }, "session-123");
    const result = JSON.parse(raw);

    expect(result.type).toBe("browser_screenshot");
    expect(mockPage.$).toHaveBeenCalledWith("#hero");
    expect(mockElement.screenshot).toHaveBeenCalledWith({
      type: "jpeg",
      quality: 75,
    });
  });

  it("throws when selector element not found", async () => {
    mockPage.$.mockResolvedValue(null);

    await expect(screenshot({ selector: "#missing" }, SID)).rejects.toThrow(
      "Element not found: #missing",
    );
  });
});

// ========================
// getContent operation test
// ========================

describe("getContent", () => {
  it("returns accessibility tree in tree mode (default)", async () => {
    const raw = await getContent({}, SID);
    const result = JSON.parse(raw);

    expect(result.type).toBe("browser_content");
    expect(result.url).toBe("https://example.com");
    expect(result.title).toBe("Example");
    expect(result.elements).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
    expect(result.token_estimate).toBeGreaterThan(0);

    // Content should contain the indexed elements from sample AX nodes
    expect(result.content).toContain("[0]");
    expect(result.content).toContain("heading");
    expect(result.content).toContain("Welcome");
    expect(result.content).toContain("textbox");
    expect(result.content).toContain("Email");
    expect(result.content).toContain("button");
    expect(result.content).toContain("Submit");
  });

  it("tree mode calls CDP Accessibility.getFullAXTree", async () => {
    await getContent({}, SID);

    expect(mockCDPSession.send).toHaveBeenCalledWith("Accessibility.enable");
    expect(mockCDPSession.send).toHaveBeenCalledWith("Accessibility.getFullAXTree");
  });

  it("tree mode filters ignored nodes", async () => {
    const raw = await getContent({}, SID);
    const result = JSON.parse(raw);

    // Node 5 is ignored, should not appear as a numbered element
    // We have document, heading, textbox, button = 4 elements max
    // But document may or may not be indexed depending on filtering
    expect(result.content).not.toContain("backendDOMNodeId: 5");
  });

  it("tree mode supports pagination with offset", async () => {
    const raw = await getContent({ offset: 0 }, SID);
    const result = JSON.parse(raw);

    // With small mock tree, should not be truncated
    expect(result.offset).toBeUndefined(); // offset 0 is not included in response
    expect(typeof result.total).toBe("number");
  });

  it("dom mode returns simplified HTML", async () => {
    mockPage.evaluate.mockResolvedValue({
      dom: "<div>Hello</div>",
      truncated: false,
    });

    const raw = await getContent({ mode: "dom" }, SID);
    const result = JSON.parse(raw);

    expect(result.type).toBe("browser_content");
    expect(result.content).toBe("<div>Hello</div>");
    expect(result.elements).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("dom mode passes options via IIFE string", async () => {
    mockPage.evaluate.mockResolvedValue({
      dom: "<p>Test</p>",
      truncated: false,
    });

    await getContent({ mode: "dom", selector: "#content", max_depth: 3 }, SID);

    expect(mockPage.evaluate).toHaveBeenCalledTimes(1);
    const call = mockPage.evaluate.mock.calls[0];
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe("string");

    const script = call[0] as string;
    expect(script).toContain('"#content"');
    expect(script).toContain('"maxDepth":3');
  });

  it("text mode returns innerText", async () => {
    mockPage.evaluate.mockResolvedValue("Hello world\nSome content");

    const raw = await getContent({ mode: "text" }, SID);
    const result = JSON.parse(raw);

    expect(result.type).toBe("browser_content");
    expect(result.content).toBe("Hello world\nSome content");
    expect(result.elements).toBe(0);
  });

  it("throws on invalid mode", async () => {
    await expect(getContent({ mode: "bogus" }, SID)).rejects.toThrow("Invalid mode");
  });

  it("retries when tree is empty on first attempt (race condition after navigation)", async () => {
    // First call returns empty tree (only an ignored root node),
    // second call returns real nodes — simulates the race condition
    // where the accessibility tree isn't ready right after navigation.
    let callCount = 0;
    mockCDPSession.send.mockImplementation((method: string) => {
      if (method === "Accessibility.enable") return Promise.resolve({});
      if (method === "Accessibility.getFullAXTree") {
        callCount++;
        if (callCount <= 1) {
          // First attempt: return only an ignored root node → 0 indexed elements
          return Promise.resolve({
            nodes: [
              {
                nodeId: "1",
                ignored: true,
                role: { type: "role", value: "document" },
                childIds: [],
                backendDOMNodeId: 1,
              },
            ],
          });
        }
        // Subsequent attempts: return real nodes
        return Promise.resolve({ nodes: makeSampleAXNodes() });
      }
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: { frame: { id: "main", url: "https://example.com" }, childFrames: [] },
        });
      }
      return Promise.resolve({});
    });

    const raw = await getContent({}, SID);
    const result = JSON.parse(raw);

    // Should have retried and returned the real tree
    expect(result.elements).toBeGreaterThan(0);
    expect(result.content).toContain("button");
    expect(result.content).toContain("Submit");
    // getFullAXTree should have been called more than once
    const axTreeCalls = mockCDPSession.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "Accessibility.getFullAXTree",
    );
    expect(axTreeCalls.length).toBeGreaterThan(1);
  });

  it("returns empty tree after all retries exhausted", async () => {
    // All calls return empty tree
    mockCDPSession.send.mockImplementation((method: string) => {
      if (method === "Accessibility.enable") return Promise.resolve({});
      if (method === "Accessibility.getFullAXTree") {
        return Promise.resolve({
          nodes: [
            {
              nodeId: "1",
              ignored: true,
              role: { type: "role", value: "document" },
              childIds: [],
              backendDOMNodeId: 1,
            },
          ],
        });
      }
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: { frame: { id: "main", url: "https://example.com" }, childFrames: [] },
        });
      }
      return Promise.resolve({});
    });

    const raw = await getContent({}, SID);
    const result = JSON.parse(raw);

    // Should return empty result after exhausting retries
    expect(result.elements).toBe(0);
  });
});

// ====================
// Click operation test
// ====================

describe("click", () => {
  it("clicks by element index using CDP coordinates", async () => {
    // First populate element map via get_content
    await getContent({}, SID);

    const raw = await click({ element: 1 }, SID);
    const result = JSON.parse(raw);

    expect(result.type).toBe("browser_click");
    expect(result.success).toBe(true);
    expect(result.clicked_at.x).toBeGreaterThan(0);
    expect(result.clicked_at.y).toBeGreaterThan(0);
    expect(result.element_role).toBe("heading");
    expect(result.element_name).toBe("Welcome");

    // Should have used viewport-based scrolling (DOM.resolveNode + Runtime.callFunctionOn for getBoundingClientRect)
    expect(mockCDPSession.send).toHaveBeenCalledWith(
      "DOM.resolveNode",
      expect.objectContaining({ backendNodeId: expect.any(Number) }),
    );

    // Should have clicked via page.mouse
    expect(mockPage.mouse.click).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ button: "left" }),
    );
  });

  it("clicks by raw coordinates", async () => {
    const raw = await click({ x: 300, y: 400 }, SID);
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.clicked_at.x).toBe(300);
    expect(result.clicked_at.y).toBe(400);
    expect(mockPage.mouse.click).toHaveBeenCalledWith(
      300,
      400,
      expect.any(Object),
    );
  });

  it("throws when element index not found (empty map)", async () => {
    await expect(click({ element: 99 }, SID)).rejects.toThrow(
      /not found.*browser_get_content/,
    );
  });

  it("throws ELEMENT_NOT_FOUND when index out of range", async () => {
    await getContent({}, SID);
    await expect(click({ element: 999 }, SID)).rejects.toThrow(/not found/);
  });

  it("throws STALE_ELEMENT when element no longer exists", async () => {
    await getContent({}, SID);

    // Make CDP calls fail (simulating stale element after page change)
    mockCDPSession.send.mockImplementation((method: string) => {
      if (method === "DOM.resolveNode") return Promise.resolve({ object: {} }); // No objectId = element not found
      if (method === "Accessibility.enable") return Promise.resolve({});
      if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: makeSampleAXNodes() });
      return Promise.resolve({});
    });

    await expect(click({ element: 1 }, SID)).rejects.toThrow(/no longer exists/);
  });

  it("throws when no target specified", async () => {
    await expect(click({}, SID)).rejects.toThrow("click requires element index");
  });

  it("passes button and click_count options", async () => {
    const raw = await click({ x: 100, y: 200, button: "right", click_count: 2 }, SID);
    JSON.parse(raw);

    expect(mockPage.mouse.click).toHaveBeenCalledWith(
      100,
      200,
      expect.objectContaining({ button: "right", clickCount: 2 }),
    );
  });
});

// ===================
// Type operation test
// ===================

describe("typeText", () => {
  it("types text into element by index", async () => {
    await getContent({}, SID);

    const raw = await typeText({ element: 2, text: "hello@example.com" }, SID);
    const result = JSON.parse(raw);

    expect(result.type).toBe("browser_type");
    expect(result.success).toBe(true);
    expect(result.typed).toBe("hello@example.com");
    expect(result.element_role).toBe("textbox");
    expect(result.element_name).toBe("Email");

    // Should click element first for focus
    expect(mockPage.mouse.click).toHaveBeenCalled();
    // Then type
    expect(mockPage.keyboard.type).toHaveBeenCalledWith(
      "hello@example.com",
      expect.objectContaining({ delay: expect.any(Number) }),
    );
  });

  it("types into currently focused element when no target", async () => {
    const raw = await typeText({ text: "hello" }, SID);
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(mockPage.mouse.click).not.toHaveBeenCalled();
    expect(mockPage.keyboard.type).toHaveBeenCalledWith(
      "hello",
      expect.any(Object),
    );
  });

  it("clear_first selects all and deletes", async () => {
    await typeText({ text: "new", clear_first: true }, SID);

    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Control+a");
    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Backspace");
    expect(mockPage.keyboard.type).toHaveBeenCalledWith(
      "new",
      expect.any(Object),
    );
  });

  it("throws on missing text", async () => {
    await expect(typeText({}, SID)).rejects.toThrow("Missing required argument: text");
  });

  it("throws STALE_ELEMENT when element no longer exists", async () => {
    await getContent({}, SID);

    // Make element resolution fail (simulating stale element after page change)
    mockCDPSession.send.mockImplementation((method: string) => {
      if (method === "DOM.resolveNode") return Promise.resolve({ object: {} }); // No objectId = element not found
      if (method === "Accessibility.enable") return Promise.resolve({});
      if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: makeSampleAXNodes() });
      return Promise.resolve({});
    });

    await expect(typeText({ element: 2, text: "hello" }, SID)).rejects.toThrow(/no longer exists/);
  });
});

// ====================
// Press operation test
// ====================

describe("pressKey", () => {
  it("presses Enter key", async () => {
    await pressKey({ key: "Enter" }, SID);

    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Enter");
  });

  it("presses Tab key", async () => {
    await pressKey({ key: "Tab" }, SID);

    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Tab");
  });

  it("presses modifier combo", async () => {
    await pressKey({ key: "Control+a" }, SID);

    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Control+a");
  });

  it("throws on missing key", async () => {
    await expect(pressKey({}, SID)).rejects.toThrow("Missing required argument: key");
  });
});

// =====================
// Scroll operation test
// =====================

describe("scroll", () => {
  it("scrolls down one page by default", async () => {
    const raw = await scroll({}, SID);
    const result = JSON.parse(raw);

    expect(result.type).toBe("browser_scroll");
    expect(result.direction).toBe("down");
    expect(result.amount).toBe("page");

    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, 1080);
  });

  it("scrolls up one page", async () => {
    await scroll({ direction: "up" }, SID);

    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, -1080);
  });

  it("scrolls half page", async () => {
    await scroll({ direction: "down", amount: "half" }, SID);

    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, 540);
  });

  it("scrolls by pixel amount", async () => {
    await scroll({ direction: "down", amount: 300 }, SID);

    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, 300);
  });

  it("scrolls to element using CDP", async () => {
    await getContent({}, SID);

    const raw = await scroll({ to_element: 2 }, SID);
    const result = JSON.parse(raw);

    expect(result.type).toBe("browser_scroll");
    expect(result.amount).toContain("to_element");
    expect(result.scrolled_to).toBeDefined();
    expect(result.scrolled_to.x).toBeGreaterThan(0);
    expect(result.scrolled_to.y).toBeGreaterThan(0);

    // Uses CDP scrollIntoViewIfNeeded for scroll operation
    expect(mockCDPSession.send).toHaveBeenCalledWith(
      "DOM.scrollIntoViewIfNeeded",
      expect.objectContaining({ backendNodeId: expect.any(Number) }),
    );
  });

  it("throws on invalid direction", async () => {
    await expect(scroll({ direction: "left" }, SID)).rejects.toThrow("Invalid direction");
  });

  it("throws ELEMENT_NOT_FOUND for to_element without get_content", async () => {
    await expect(scroll({ to_element: 5 }, SID)).rejects.toThrow(/not found/);
  });
});

// =====================
// GetText operation test
// =====================

describe("getText", () => {
  it("returns full text for elements by index", async () => {
    // First populate element map
    await getContent({}, SID);

    // Setup CDP mocks for getText
    mockCDPSession.send.mockImplementation((method: string) => {
      if (method === "DOM.resolveNode") {
        return Promise.resolve({ object: { objectId: "obj-123" } });
      }
      if (method === "Runtime.callFunctionOn") {
        return Promise.resolve({ result: { value: "Full text content here" } });
      }
      if (method === "Runtime.releaseObject") {
        return Promise.resolve({});
      }
      // Default fallbacks for other methods
      if (method === "Accessibility.enable") return Promise.resolve({});
      if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: makeSampleAXNodes() });
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: { frame: { id: "main", url: "https://example.com" }, childFrames: [] },
        });
      }
      return Promise.resolve({});
    });

    const raw = await getText({ elements: [1, 2] }, SID);
    const result = JSON.parse(raw);

    expect(result.type).toBe("browser_get_text");
    expect(result.elements).toHaveLength(2);
    expect(result.elements[0].index).toBe(1);
    expect(result.elements[0].text).toBe("Full text content here");
    expect(result.elements[0].role).toBe("heading");
    expect(result.elements[1].index).toBe(2);
  });

  it("throws when elements array is missing", async () => {
    await expect(getText({}, SID)).rejects.toThrow("Missing required argument: elements");
  });

  it("throws when elements array is empty", async () => {
    await expect(getText({ elements: [] }, SID)).rejects.toThrow("Missing required argument: elements");
  });

  it("throws when too many elements requested", async () => {
    const tooMany = Array.from({ length: 25 }, (_, i) => i);
    await expect(getText({ elements: tooMany }, SID)).rejects.toThrow("Too many elements");
  });

  it("returns error for invalid element index", async () => {
    await getContent({}, SID);

    const raw = await getText({ elements: [999] }, SID);
    const result = JSON.parse(raw);

    expect(result.elements[0].index).toBe(999);
    expect(result.elements[0].error).toBeDefined();
  });

  it("falls back to accessibility name when DOM.resolveNode returns no objectId", async () => {
    await getContent({}, SID);

    mockCDPSession.send.mockImplementation((method: string) => {
      if (method === "DOM.resolveNode") {
        return Promise.resolve({ object: {} }); // No objectId
      }
      if (method === "Accessibility.enable") return Promise.resolve({});
      if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: makeSampleAXNodes() });
      if (method === "Page.getFrameTree") {
        return Promise.resolve({
          frameTree: { frame: { id: "main", url: "https://example.com" }, childFrames: [] },
        });
      }
      return Promise.resolve({});
    });

    const raw = await getText({ elements: [1] }, SID);
    const result = JSON.parse(raw);

    // Should fall back to accessibility name
    expect(result.elements[0].text).toBe("Welcome");
  });
});

// =======================
// ExecuteJs operation test
// =======================

describe("executeJs", () => {
  it("executes script and returns result", async () => {
    mockPage.evaluate.mockResolvedValue(42);

    const raw = await executeJs({ script: "return 42" }, SID);
    const result = JSON.parse(raw);

    expect(result.type).toBe("browser_js");
    expect(result.result).toBe(42);
  });

  it("wraps script in async IIFE", async () => {
    mockPage.evaluate.mockResolvedValue(null);

    await executeJs({ script: "return await fetch('/api')" }, SID);

    expect(mockPage.evaluate).toHaveBeenCalledWith(
      expect.stringContaining("(async () => {"),
    );
    expect(mockPage.evaluate).toHaveBeenCalledWith(
      expect.stringContaining("return await fetch('/api')"),
    );
  });

  it("throws on missing script", async () => {
    await expect(executeJs({}, SID)).rejects.toThrow("Missing required argument: script");
  });

  it("wraps evaluation errors", async () => {
    mockPage.evaluate.mockRejectedValue(new Error("ReferenceError: foo is not defined"));

    await expect(executeJs({ script: "foo()" }, SID)).rejects.toThrow(
      "JavaScript execution error: ReferenceError: foo is not defined",
    );
  });

  it("returns null for undefined result", async () => {
    mockPage.evaluate.mockResolvedValue(undefined);

    const raw = await executeJs({ script: "void 0" }, SID);
    const result = JSON.parse(raw);

    expect(result.result).toBeNull();
  });

  it("handles complex return values", async () => {
    const complex = { items: [1, 2, 3], nested: { key: "value" } };
    mockPage.evaluate.mockResolvedValue(complex);

    const raw = await executeJs({ script: "return {items: [1,2,3], nested: {key: 'value'}}" }, SID);
    const result = JSON.parse(raw);

    expect(result.result).toEqual(complex);
  });
});

// ========================
// Connection manager tests
// ========================

describe("connection manager", () => {
  it("getBrowserPage creates session with chromium.launch", async () => {
    const page = await getBrowserPage(SID);
    expect(page).toBeDefined();
    expect(mockChromium.launch).toHaveBeenCalled();
  });

  it("launches Chrome with --no-sandbox for Docker/root environments", async () => {
    await getBrowserPage(SID);
    expect(mockChromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["--no-sandbox"]),
      }),
    );
  });

  it("passes correct HOME in env so Chrome can write to user home dir", async () => {
    await getBrowserPage(SID);
    expect(mockChromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          HOME: expect.any(String),
        }),
      }),
    );
    // HOME should not be /root (which causes Chrome to crash when running as non-root)
    const launchCall = mockChromium.launch.mock.calls[0][0];
    expect(launchCall.env.HOME).not.toBe("/root");
  });

  it("isBrowserConnected returns true after session creation", async () => {
    await getBrowserPage(SID);
    expect(isBrowserConnected(SID)).toBe(true);
  });

  it("isBrowserConnected returns false for unknown session", () => {
    expect(isBrowserConnected("nonexistent")).toBe(false);
  });

  it("cleanupBrowserSession destroys session", async () => {
    await getBrowserPage(SID);
    await cleanupBrowserSession(SID);
    expect(mockBrowser.close).toHaveBeenCalled();
    expect(isBrowserConnected(SID)).toBe(false);
  });

  it("reconnectBrowser destroys and recreates session", async () => {
    await getBrowserPage(SID);
    const launchCountBefore = mockChromium.launch.mock.calls.length;

    await reconnectBrowser(SID);

    // Should have called close on the old browser and launched again
    expect(mockBrowser.close).toHaveBeenCalled();
    expect(mockChromium.launch.mock.calls.length).toBe(launchCountBefore + 1);
  });

  it("reconnectBrowser stores endpoint override when provided", async () => {
    await reconnectBrowser(SID, "http://localhost:9222");

    const session = browserSessionManager.get(SID);
    expect(session?.wsEndpointOverride).toBe("http://localhost:9222");
  });

  it("reconnectBrowser without endpoint has no override", async () => {
    await reconnectBrowser(SID, "http://localhost:9222");
    await reconnectBrowser(SID); // no endpoint

    const session = browserSessionManager.get(SID);
    expect(session?.wsEndpointOverride).toBeNull();
  });

  it("connect operation always reconnects even if already connected", async () => {
    // First connect
    const raw1 = await browserTool.execute({ operation: "connect" }, "s1");
    const result1 = JSON.parse(raw1);
    expect(result1.status).toBe("connected");

    const launchCountBefore = mockChromium.launch.mock.calls.length;

    // Second connect — should still reconnect, not return already_connected
    const raw2 = await browserTool.execute({ operation: "connect" }, "s1");
    const result2 = JSON.parse(raw2);
    expect(result2.status).toBe("connected");
    expect(mockChromium.launch.mock.calls.length).toBe(launchCountBefore + 1);
  });

  it("connect operation with custom endpoint stores override", async () => {
    const raw = await browserTool.execute(
      { operation: "connect", address: "localhost:9222" },
      "s1",
    );
    const result = JSON.parse(raw);
    expect(result.status).toBe("connected");

    const session = browserSessionManager.get("s1");
    expect(session?.wsEndpointOverride).toBe("localhost:9222");
  });
});

// ==============================
// Element map lifecycle tests
// ==============================

describe("element map lifecycle", () => {
  it("get_content populates element map for subsequent click", async () => {
    await getContent({}, SID);

    // Now click should work with element indices
    const raw = await click({ element: 1 }, SID);
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
  });

  it("navigate clears element map", async () => {
    await getContent({}, SID);

    // Navigate should clear the map
    mockPage.goto.mockResolvedValue({ status: () => 200 });
    await navigate({ url: "https://example.com/new" }, SID);

    // Now click by element should fail
    await expect(click({ element: 1 }, SID)).rejects.toThrow(/not found.*browser_get_content/);
  });

  it("Accessibility.enable is called eagerly when CDPSession is created", async () => {
    // Reset to track calls cleanly
    mockCDPSession.send.mockClear();

    // get_content triggers CDPSession creation which should call Accessibility.enable
    await getContent({}, SID);

    const sendCalls = mockCDPSession.send.mock.calls.map((c: unknown[]) => c[0]);
    const enableIdx = sendCalls.indexOf("Accessibility.enable");
    const treeIdx = sendCalls.indexOf("Accessibility.getFullAXTree");

    expect(enableIdx).toBeGreaterThanOrEqual(0);
    expect(treeIdx).toBeGreaterThan(enableIdx);
  });

  it("navigate invalidates CDP session so next get_content creates a fresh one", async () => {
    await getContent({}, SID);

    // At this point a CDPSession has been created
    const firstSessionCallCount = mockContext.newCDPSession.mock.calls.length;

    // Navigate — should invalidate the CDPSession
    mockPage.goto.mockResolvedValue({ status: () => 200 });
    await navigate({ url: "https://example.com/new" }, SID);

    // The old session should have been detached
    expect(mockCDPSession.detach).toHaveBeenCalled();

    // Next get_content should create a new CDPSession
    await getContent({}, SID);
    expect(mockContext.newCDPSession.mock.calls.length).toBeGreaterThan(firstSessionCallCount);
  });

  it("destroy clears element map", async () => {
    await getContent({}, SID);

    await cleanupBrowserSession(SID);

    // After session destruction, next click creates new session with empty element map
    await expect(click({ element: 1 }, SID)).rejects.toThrow(/not found/);
  });

  it("get_content refreshes element map", async () => {
    await getContent({}, SID);

    // Call get_content again — should update the map
    await getContent({}, SID);

    // Click should still work
    const raw = await click({ element: 1 }, SID);
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
  });
});

// ===============================
// Tool execute dispatch tests
// ===============================

describe("browserTool.execute dispatch", () => {
  it("dispatches connect operation", async () => {
    const raw = await browserTool.execute(
      { operation: "connect" },
      "session-1",
    );
    const result = JSON.parse(raw);
    expect(result.type).toBe("browser_connect");
    expect(result.status).toBe("connected");
  });

  it("dispatches disconnect operation", async () => {
    const raw = await browserTool.execute(
      { operation: "disconnect" },
      "session-1",
    );
    const result = JSON.parse(raw);
    expect(result.type).toBe("browser_disconnect");
  });

  it("dispatches navigate operation", async () => {
    mockPage.goto.mockResolvedValue({ status: () => 200 });
    const raw = await browserTool.execute(
      { operation: "navigate", url: "https://example.com" },
      "session-1",
    );
    const result = JSON.parse(raw);
    expect(result.type).toBe("browser_navigate");
  });

  it("dispatches screenshot operation", async () => {
    const raw = await browserTool.execute(
      { operation: "screenshot" },
      "session-1",
    );
    const result = JSON.parse(raw);
    expect(result.type).toBe("browser_screenshot");
  });

  it("dispatches click operation", async () => {
    // Import getContent to populate element map for click test
    // (getContent is still available internally, just not exposed to main LLM)
    const { getContent } = await import("../services/tools/browser/operations/getContent.js");

    // Populate element map by calling getContent
    await getContent({}, "session-1");

    const raw = await browserTool.execute(
      { operation: "click", element: 1 },
      "session-1",
    );
    const result = JSON.parse(raw);
    expect(result.type).toBe("browser_click");
  });

  it("dispatches type operation", async () => {
    const raw = await browserTool.execute(
      { operation: "type", text: "hello" },
      "session-1",
    );
    const result = JSON.parse(raw);
    expect(result.type).toBe("browser_type");
  });

  it("dispatches press operation", async () => {
    const raw = await browserTool.execute(
      { operation: "press", key: "Enter" },
      "session-1",
    );
    const result = JSON.parse(raw);
    expect(result.type).toBe("browser_press");
  });

  it("dispatches scroll operation", async () => {
    const raw = await browserTool.execute(
      { operation: "scroll", direction: "down" },
      "session-1",
    );
    const result = JSON.parse(raw);
    expect(result.type).toBe("browser_scroll");
  });

  it("throws on unknown operation", async () => {
    await expect(
      browserTool.execute({ operation: "bogus" }, "session-1"),
    ).rejects.toThrow("Unknown browser operation: bogus");
  });
});
