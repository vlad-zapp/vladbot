import type { JsonSchemaProperty } from "@vladbot/shared";
import type { Tool, ToolExecuteContext } from "../ToolExecutor.js";
import { buildOperationToolDef } from "../buildToolDef.js";
import { getBrowserPage, isBrowserConnected, disconnectBrowser, reconnectBrowser } from "./connection.js";
import { navigate } from "./operations/navigate.js";
import { screenshot } from "./operations/screenshot.js";
import { click } from "./operations/click.js";
import { typeText } from "./operations/type.js";
import { pressKey } from "./operations/press.js";
import { scroll } from "./operations/scroll.js";
import { executeJs } from "./operations/executeJs.js";
import { getBrowserServiceForSession } from "./BrowserService.js";
import type { BrowserConnectResult, BrowserDisconnectResult } from "./types.js";

const P: Record<string, JsonSchemaProperty> = {
  address: {
    type: "string",
    description:
      'HTTP address of a remote Chrome/Chromium CDP debugging port (e.g. "localhost:9222"). Only use when the user explicitly asks to connect to a specific browser.',
  },
  url: {
    type: "string",
    description: "URL to navigate to.",
  },
  wait_until: {
    type: "string",
    description:
      'When to consider navigation complete. "domcontentloaded" (default), "load", or "networkidle".',
    enum: ["load", "domcontentloaded", "networkidle"],
  },
  selector: {
    type: "string",
    description: "CSS selector to scope screenshot to a specific element.",
  },
  question: {
    type: "string",
    description: 'Focus the description on a specific question or element. E.g., "what products are shown?", "find the login form", "where is the login button?".',
  },
  query: {
    type: "string",
    description: 'What elements to find. E.g., "all laptop product cards", "all links in navigation", "all form fields".',
  },
  offset: {
    type: "number",
    description: "Pagination offset. Start with 0, then use next_offset from previous response to get more results.",
  },
  element: {
    type: "number",
    description: "Element ID from browser_describe or browser_find output (e.g., [42]).",
  },
  text: {
    type: "string",
    description: "Text to type. For special keys like Enter, use browser_press instead.",
  },
  clear_first: {
    type: "boolean",
    description: "Clear the field before typing. Default: true.",
  },
  key: {
    type: "string",
    description:
      'Key to press. Common: "Enter", "Tab", "Escape", "Backspace", "ArrowUp/Down/Left/Right". Modifiers: "Control+a", "Control+c", "Control+v".',
  },
  direction: {
    type: "string",
    description: 'Scroll direction. "down" (default) or "up".',
    enum: ["up", "down"],
  },
  amount: {
    type: "string",
    description: '"page" (default), "half", or a pixel count.',
  },
  to_element: {
    type: "number",
    description: "Element ID to scroll into view. Overrides direction/amount.",
  },
  button: {
    type: "string",
    description: 'Mouse button. "left" (default), "right", or "middle".',
    enum: ["left", "right", "middle"],
  },
  click_count: {
    type: "number",
    description: "Number of clicks. Default: 1. Use 2 for double-click.",
  },
  script: {
    type: "string",
    description: "JavaScript code to execute in the page context. For scraping data that describe/find_all cannot extract.",
  },
};

export const browserTool: Tool = {
  definition: buildOperationToolDef({
    name: "browser",
    description: `Control a web browser for automation, scraping, and interaction.

Auto-connects on first use — no need to call browser_connect first.

WORKFLOW:
1. browser_navigate to a URL
2. browser_describe to understand the page and get element IDs (e.g., "[42] search button")
3. browser_click / browser_type using element IDs from describe
4. After actions that change the page, call describe again

ELEMENT IDs: Use [ID] numbers from describe/find_all results. Example: if describe returns "[42] search button", use browser_click with element=42.

Use browser_describe for understanding pages and finding specific elements:
- General overview: call without question
- Specific element: "find the search input", "where is the login button?"

Use browser_find_all when you need ALL items of a certain type (for scraping/collecting data):
- Specify what to find AND what details you need in the query
- Example: "all product cards with name, price, and availability"
- Each element includes: ID + description with all requested details
- Results are paginated (~8k tokens per response). Use offset=next_offset to get more.
- Cache is maintained per query - changing query resets and searches again.

IMPORTANT: Always use browser_describe or browser_find_all to find elements. Do NOT use screenshots or vision_analyze for finding elements - they are slower and less reliable. Only take screenshots when the user explicitly asks to see the page.

Operations:
- connect: (Re)connect to browser. Pass address only when user asks to connect to a specific remote browser.
- disconnect: Disconnect from browser session.
- navigate: Go to a URL. Returns page title and final URL.
- describe: Get a description of the page with element IDs. Use question param to focus on specific elements.
- find_all: Find ALL elements matching a query. Returns paginated list with IDs. Use for collecting/scraping multiple items.
- screenshot: Capture viewport screenshot. ONLY use when user explicitly asks to see the page - never for finding elements.
- click: Click an element by ID.
- type: Type text into an element.
- press: Press keyboard key (Enter, Tab, Escape, arrows, shortcuts).
- scroll: Scroll viewport or to a specific element.
- execute_js: Execute JavaScript in page context. For scraping data that describe/find_all cannot extract.`,
    params: P,
    operations: {
      connect: { params: ["address"] },
      disconnect: { params: [] },
      navigate: { params: ["url", "wait_until"], required: ["url"] },
      describe: { params: ["question"] },
      find_all: { params: ["query", "offset"], required: ["query"] },
      screenshot: { params: ["selector"] },
      click: { params: ["element", "button", "click_count"], required: ["element"] },
      type: { params: ["text", "element", "clear_first"], required: ["text"] },
      press: { params: ["key"], required: ["key"] },
      scroll: { params: ["direction", "amount", "to_element"] },
      execute_js: { params: ["script"], required: ["script"] },
    },
  }),

  validate(args) {
    const op = args.operation as string;
    if (op === "connect") {
      const ep = args.address as string | undefined;
      if (ep && (ep.startsWith("ws://") || ep.startsWith("wss://"))) {
        return {
          valid: false,
          error: "ws:// is not supported. Provide a plain address or http:// URL.",
        };
      }
    }
    if (op === "navigate") {
      const url = args.url as string | undefined;
      if (!url) return { valid: false, error: "Missing required argument: url" };
      try {
        new URL(url);
      } catch {
        return { valid: false, error: `Invalid URL: ${url}` };
      }
    }
    if (op === "type") {
      if (!args.text) return { valid: false, error: "Missing required argument: text" };
    }
    if (op === "press") {
      if (!args.key) return { valid: false, error: "Missing required argument: key" };
    }
    if (op === "click") {
      if (args.element === undefined) {
        return {
          valid: false,
          error: "Missing required argument: element. Use browser_describe or browser_find_all first to get element IDs.",
        };
      }
    }
    if (op === "find_all") {
      if (!args.query) {
        return { valid: false, error: "Missing required argument: query" };
      }
    }
    if (op === "execute_js") {
      if (!args.script) {
        return { valid: false, error: "Missing required argument: script" };
      }
    }
    return { valid: true };
  },

  async execute(args, sessionId, context?: ToolExecuteContext) {
    const op = args.operation as string;

    switch (op) {
      case "connect":
        return connect(args);
      case "disconnect":
        return disconnect();
      case "navigate":
        return navigate(args, sessionId);
      case "screenshot":
        return screenshot(args, sessionId);
      case "click":
        return click(args, sessionId);
      case "type":
        return typeText(args, sessionId);
      case "press":
        return pressKey(args);
      case "scroll":
        return scroll(args);
      case "execute_js":
        return executeJs(args);

      // Sub-LLM powered operations
      case "describe": {
        if (!sessionId) throw new Error("Session ID required for browser_describe");
        const service = await getBrowserServiceForSession(sessionId);

        // Create progress callback that emits SSE events
        const onProgress = context?.onProgress && context.toolCallId
          ? (progress: number, total: number, message?: string) => {
              context.onProgress!(context.toolCallId!, "browser_describe", progress, total, message);
            }
          : undefined;

        const result = await service.describe(args.question as string | undefined, onProgress);
        return JSON.stringify({
          type: "browser_describe",
          description: result.description,
          parts_processed: result.pagesProcessed,
          total_elements: result.totalElements,
        });
      }

      case "find_all": {
        if (!sessionId) throw new Error("Session ID required for browser_find_all");
        const service = await getBrowserServiceForSession(sessionId);
        const query = args.query as string;
        const offset = (args.offset as number) ?? 0;

        // Create progress callback that emits SSE events
        const onProgress = context?.onProgress && context.toolCallId
          ? (progress: number, total: number, message?: string) => {
              context.onProgress!(context.toolCallId!, "browser_find_all", progress, total, message);
            }
          : undefined;

        const result = await service.findAll(query, offset, onProgress);
        return JSON.stringify({
          type: "browser_find_all",
          elements: result.elements,
          count: result.elements.length,
          has_more: result.hasMore,
          next_offset: result.hasMore ? result.nextOffset : undefined,
          total: result.total,
        });
      }

      default:
        throw new Error(`Unknown browser operation: ${op}`);
    }
  },
};

async function connect(args: Record<string, unknown>): Promise<string> {
  const address = args.address as string | undefined;
  const page = await reconnectBrowser(address);

  const result: BrowserConnectResult = {
    type: "browser_connect",
    status: "connected",
    url: page.url(),
    title: await page.title(),
  };

  return JSON.stringify(result);
}

function disconnect(): string {
  const wasConnected = isBrowserConnected();
  disconnectBrowser();

  const result: BrowserDisconnectResult = {
    type: "browser_disconnect",
    status: wasConnected ? "disconnected" : "not_connected",
  };

  return JSON.stringify(result);
}
