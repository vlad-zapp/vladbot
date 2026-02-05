export interface BrowserConnectResult {
  type: "browser_connect";
  status: "connected";
  url?: string;
  title?: string;
}

export interface BrowserDisconnectResult {
  type: "browser_disconnect";
  status: "disconnected" | "not_connected";
}

export interface BrowserNavigateResult {
  type: "browser_navigate";
  url: string;
  title: string;
  status: number | null;
  /** Note when status looks like error but page loaded via JS */
  note?: string;
  image_url?: string;
  image_base64?: string;
}

export interface BrowserScreenshotResult {
  type: "browser_screenshot";
  width: number;
  height: number;
  url?: string;
  title?: string;
  image_url?: string;
  image_base64?: string;
}

/** Reference to a DOM element discovered via CDP accessibility tree. */
export interface ElementRef {
  backendDOMNodeId: number;
  role: string;
  name: string;
  mapVersion: number;
}

export interface BrowserContentResult {
  type: "browser_content";
  url: string;
  title: string;
  content: string;
  elements: number;
  truncated: boolean;
  token_estimate: number;
  /** Offset used for pagination (element index for tree mode, char offset for text/dom). */
  offset?: number;
  /** Total elements available (tree mode) or total chars (text/dom mode). */
  total?: number;
  /** True if more content is available after current page. */
  has_more?: boolean;
  /** Next offset to use for pagination (element index for tree, char offset for text/dom). */
  next_offset?: number;
}

export interface BrowserClickResult {
  type: "browser_click";
  success: boolean;
  clicked_at: { x: number; y: number };
  element_role?: string;
  element_name?: string;
  image_url?: string;
  image_base64?: string;
}

export interface BrowserTypeResult {
  type: "browser_type";
  success: boolean;
  typed: string;
  element_role?: string;
  element_name?: string;
  image_url?: string;
  image_base64?: string;
}

export interface BrowserPressResult {
  type: "browser_press";
  success: boolean;
  key: string;
}

export interface BrowserScrollResult {
  type: "browser_scroll";
  direction: "up" | "down";
  amount: string;
  scrolled_to?: { x: number; y: number };
}

export interface BrowserJsResult {
  type: "browser_js";
  result: unknown;
}

export interface BrowserGetTextResult {
  type: "browser_get_text";
  elements: Array<{
    index: number;
    text: string;
    role: string;
    error?: string;
  }>;
}
