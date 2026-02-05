import type { CDPSession } from "patchright";
import type { ElementRef } from "./types.js";

// CDP types (not exported by Playwright/Patchright)
interface AXValue {
  type: string;
  value?: string | number | boolean;
}

interface AXProperty {
  name: string;
  value: AXValue;
}

interface AXNode {
  nodeId: string;
  ignored: boolean;
  ignoredReasons?: AXValue[];
  role?: AXValue;
  name?: AXValue;
  description?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

interface FrameInfo {
  id: string;
  name?: string;
  url: string;
}

interface FrameTree {
  frame: FrameInfo;
  childFrames?: FrameTree[];
}

interface TreeNode {
  index: number;
  role: string;
  name: string;
  value?: string;
  properties: Map<string, string | boolean | number>;
  children: TreeNode[];
  depth: number;
  frameName?: string;
  backendDOMNodeId: number;
}

const FILTERED_ROLES = new Set([
  "none",
  "presentation",
  "InlineTextBox",
]);

const MAX_IFRAMES = 10;
const MAX_CONTENT_LENGTH = 50_000;

/** Properties worth showing in the text output. */
const DISPLAY_PROPERTIES = new Set([
  "checked",
  "selected",
  "disabled",
  "focused",
  "expanded",
  "required",
  "level",
  "valuemin",
  "valuemax",
  "valuenow",
  "readonly",
]);

export interface AccessibilityTreeResult {
  content: string;
  elements: Map<number, ElementRef>;
  truncated: boolean;
  /** Total elements found. */
  totalElements: number;
  /** Offset used for pagination (element index). */
  offset: number;
  /** Index of the last element included + 1 (use as next offset). */
  endIndex: number;
  /** True if more elements exist after the returned range. */
  hasMore: boolean;
}

const RETRY_DELAY_MS = 150;
const MAX_RETRIES = 3;

/**
 * Fetch the CDP accessibility tree for the page and all accessible iframes.
 * Returns a formatted text tree with indexed elements and an element map.
 *
 * Retries automatically when the tree is empty — this handles the race
 * condition where `get_content` is called right after navigation and the
 * browser hasn't finished computing the accessibility tree yet.
 */
export async function fetchAccessibilityTree(
  cdp: CDPSession,
  options: { maxChars?: number; offset?: number } = {},
): Promise<AccessibilityTreeResult> {
  const maxChars = options.maxChars ?? 20_000;
  const offset = options.offset ?? 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await fetchTreeOnce(cdp, maxChars, offset);

    // If we got meaningful elements, return immediately
    if (result.elements.size > 0) {
      return result;
    }

    // Empty tree — likely a race condition after navigation.
    // Wait and retry, unless we've exhausted retries.
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  // All retries exhausted — return whatever we got (empty tree)
  return fetchTreeOnce(cdp, maxChars, offset);
}

/** Hard limit on total elements we'll index (memory safety). */
const ABSOLUTE_MAX_ELEMENTS = 5000;

async function fetchTreeOnce(
  cdp: CDPSession,
  maxChars: number,
  offset: number,
): Promise<AccessibilityTreeResult> {
  const elementMap = new Map<number, ElementRef>();
  let index = 0;

  // Accessibility.enable is called eagerly when the CDPSession is created
  // (in connection.ts getCDPSession), so it's already active here.

  // --- Main frame ---
  const { nodes: mainNodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
    nodes: AXNode[];
  };

  const mainTree = buildTree(mainNodes, () => {
    if (index >= ABSOLUTE_MAX_ELEMENTS) return -1;
    return index++;
  }, elementMap);

  // --- Iframes ---
  let iframeCount = 0;
  try {
    const { frameTree } = (await cdp.send("Page.getFrameTree")) as {
      frameTree: FrameTree;
    };
    const childFrames = flattenFrameTree(frameTree).filter(
      (f) => f.id !== frameTree.frame.id,
    );

    for (const frame of childFrames) {
      if (iframeCount >= MAX_IFRAMES) break;
      if (index >= ABSOLUTE_MAX_ELEMENTS) break;

      try {
        const { nodes: frameNodes } = (await cdp.send(
          "Accessibility.getFullAXTree",
          { frameId: frame.id },
        )) as { nodes: AXNode[] };

        const frameTree = buildTree(frameNodes, () => {
          if (index >= ABSOLUTE_MAX_ELEMENTS) return -1;
          return index++;
        }, elementMap, frame.name || frame.id);

        if (frameTree.length > 0) {
          // Wrap iframe elements in an iframe node (unindexed)
          const iframeNode: TreeNode = {
            index: -1,
            role: "iframe",
            name: frame.name || frame.url || frame.id,
            children: frameTree,
            depth: 0,
            properties: new Map(),
            backendDOMNodeId: -1,
            frameName: frame.name || frame.id,
          };
          mainTree.push(iframeNode);
          iframeCount++;
        }
      } catch {
        // Cross-origin or inaccessible iframe — skip
      }
    }
  } catch {
    // Page.getFrameTree can fail — not critical
  }

  const totalElements = index;

  // --- Format with character budget ---
  const { content, lastIndex } = formatTreeWithBudget(mainTree, 0, offset, maxChars);
  const endIndex = lastIndex + 1;
  const hasMore = endIndex < totalElements;
  const truncated = hasMore;

  return {
    content,
    elements: elementMap,
    truncated,
    totalElements,
    offset,
    endIndex,
    hasMore,
  };
}

function buildTree(
  nodes: AXNode[],
  nextIndex: () => number,
  elementMap: Map<number, ElementRef>,
  frameName?: string,
): TreeNode[] {
  // Build lookup: nodeId -> AXNode
  const nodeById = new Map<string, AXNode>();
  for (const n of nodes) {
    nodeById.set(n.nodeId, n);
  }

  // Find root nodes (nodes without parentId or whose parent is not in this set)
  const rootIds: string[] = [];
  for (const n of nodes) {
    if (!n.parentId || !nodeById.has(n.parentId)) {
      rootIds.push(n.nodeId);
    }
  }

  function processNode(axNode: AXNode, depth: number): TreeNode | null {
    if (shouldFilter(axNode)) {
      // Even if this node is filtered, process children (they bubble up)
      const bubbledChildren: TreeNode[] = [];
      for (const childId of axNode.childIds ?? []) {
        const child = nodeById.get(childId);
        if (child) {
          const result = processNode(child, depth);
          if (result) bubbledChildren.push(result);
        }
      }
      return bubbledChildren.length === 1
        ? bubbledChildren[0]
        : bubbledChildren.length > 1
          ? { index: -1, role: "", name: "", children: bubbledChildren, depth, properties: new Map(), backendDOMNodeId: -1 }
          : null;
    }

    const idx = nextIndex();
    if (idx === -1 && axNode.backendDOMNodeId !== undefined) {
      // Max elements reached; still skip but don't index
      return null;
    }

    const role = String(axNode.role?.value ?? "unknown");
    const name = String(axNode.name?.value ?? "");
    const value = axNode.value?.value !== undefined ? String(axNode.value.value) : undefined;

    const properties = new Map<string, string | boolean | number>();
    if (value !== undefined) properties.set("value", value);
    for (const prop of axNode.properties ?? []) {
      if (DISPLAY_PROPERTIES.has(prop.name) && prop.value.value !== undefined) {
        properties.set(prop.name, prop.value.value as string | boolean | number);
      }
    }

    if (idx >= 0 && axNode.backendDOMNodeId !== undefined) {
      elementMap.set(idx, {
        backendDOMNodeId: axNode.backendDOMNodeId,
        role,
        name,
        mapVersion: 0, // Set by updateElementMap
      });
    }

    // Process children
    const children: TreeNode[] = [];
    for (const childId of axNode.childIds ?? []) {
      const child = nodeById.get(childId);
      if (child) {
        const result = processNode(child, depth + 1);
        if (result) {
          // If the result is a "wrapper" (no index, no role), flatten its children
          if (result.index === -1 && result.role === "") {
            children.push(...result.children);
          } else {
            children.push(result);
          }
        }
      }
    }

    return {
      index: idx,
      role,
      name,
      value,
      properties,
      children,
      depth,
      frameName,
      backendDOMNodeId: axNode.backendDOMNodeId ?? -1,
    };
  }

  const roots: TreeNode[] = [];
  for (const rootId of rootIds) {
    const node = nodeById.get(rootId);
    if (node) {
      const result = processNode(node, 0);
      if (result) {
        if (result.index === -1 && result.role === "") {
          roots.push(...result.children);
        } else {
          roots.push(result);
        }
      }
    }
  }

  return roots;
}

function shouldFilter(node: AXNode): boolean {
  if (node.ignored) return true;

  const role = String(node.role?.value ?? "");
  if (FILTERED_ROLES.has(role)) return true;

  // Filter generic containers (div/span) unless they have a meaningful name or value
  if (role === "generic") {
    const hasName = node.name?.value && String(node.name.value).trim().length > 0;
    const hasValue = node.value?.value !== undefined;
    const isFocusable = node.properties?.some(
      (p) => p.name === "focusable" && p.value.value === true,
    );
    if (!hasName && !hasValue && !isFocusable) return true;
  }

  return false;
}

interface FormatResult {
  content: string;
  lastIndex: number;
}

/**
 * Format tree with a character budget, starting from offset.
 * Returns the formatted content and the index of the last element included.
 */
function formatTreeWithBudget(
  nodes: TreeNode[],
  depth: number,
  startIndex: number,
  maxChars: number,
): FormatResult {
  const lines: string[] = [];
  let charCount = 0;
  let lastIndex = startIndex - 1;

  function formatNode(node: TreeNode, nodeDepth: number): boolean {
    const indent = "  ".repeat(nodeDepth);

    if (node.index >= 0) {
      // Skip elements before startIndex
      if (node.index < startIndex) {
        // Still process children
        for (const child of node.children) {
          if (!formatNode(child, nodeDepth)) return false;
        }
        return true;
      }

      // Format this element - no truncation to preserve full details for scraping
      let line = `${indent}[${node.index}] ${node.role}`;
      if (node.name) {
        line += ` "${node.name}"`;
      }
      for (const [key, val] of node.properties) {
        if (key === "value") {
          line += ` value="${String(val)}"`;
        } else if (typeof val === "boolean") {
          line += ` ${key}=${val}`;
        } else {
          line += ` ${key}=${val}`;
        }
      }

      // Check if adding this line would exceed budget
      const lineLen = line.length + 1; // +1 for newline
      if (charCount + lineLen > maxChars && lines.length > 0) {
        return false; // Budget exhausted
      }

      lines.push(line);
      charCount += lineLen;
      lastIndex = node.index;
    } else if (node.role === "iframe") {
      // Check if any children are >= startIndex
      const hasRelevantChildren = hasNodesFrom(node.children, startIndex);
      if (hasRelevantChildren) {
        const line = `${indent}[iframe] "${node.name}"`;
        const lineLen = line.length + 1;
        if (charCount + lineLen > maxChars && lines.length > 0) {
          return false;
        }
        lines.push(line);
        charCount += lineLen;
      }
    }

    // Process children
    if (node.children.length > 0) {
      const childDepth = node.index >= 0 || node.role === "iframe" ? nodeDepth + 1 : nodeDepth;
      for (const child of node.children) {
        if (!formatNode(child, childDepth)) return false;
      }
    }

    return true;
  }

  for (const node of nodes) {
    if (!formatNode(node, depth)) break;
  }

  return {
    content: lines.join("\n"),
    lastIndex: Math.max(lastIndex, startIndex - 1),
  };
}

function hasNodesFrom(nodes: TreeNode[], startIndex: number): boolean {
  for (const node of nodes) {
    if (node.index >= startIndex) return true;
    if (hasNodesFrom(node.children, startIndex)) return true;
  }
  return false;
}

function flattenFrameTree(tree: FrameTree): FrameInfo[] {
  const result: FrameInfo[] = [tree.frame];
  for (const child of tree.childFrames ?? []) {
    result.push(...flattenFrameTree(child));
  }
  return result;
}

function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
