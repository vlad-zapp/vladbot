import { getBrowserPage, getCDPSession, updateElementMap } from "../connection.js";
import { fetchAccessibilityTree } from "../cdp.js";
import type { BrowserContentResult } from "../types.js";

/**
 * In-page script that extracts a simplified DOM representation.
 * Strips scripts, styles, SVGs, hidden elements.
 * Keeps semantic tags, text, links, inputs, aria labels.
 */
const SIMPLIFIED_DOM_SCRIPT = `
(options) => {
  const { selector, maxDepth, maxLength } = options;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'LINK', 'META', 'HEAD',
    'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE',
  ]);

  const KEEP_ATTRS = new Set([
    'href', 'src', 'alt', 'placeholder', 'value', 'aria-label',
    'role', 'type', 'name', 'id', 'class', 'for', 'action', 'method',
    'title', 'aria-describedby', 'aria-expanded', 'aria-selected',
    'aria-checked', 'aria-disabled', 'data-testid',
  ]);

  function isHidden(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const style = window.getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  }

  function serialize(node, depth) {
    if (depth > maxDepth) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\\s+/g, ' ').trim();
      return text || '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node;
    const tag = el.tagName;

    if (SKIP_TAGS.has(tag)) return '';
    try { if (isHidden(el)) return ''; } catch { /* ignore */ }

    const attrs = [];
    for (const attr of el.attributes) {
      if (KEEP_ATTRS.has(attr.name)) {
        let val = attr.value.trim();
        if (val.length > 200) val = val.slice(0, 200) + '...';
        if (val) attrs.push(attr.name + '="' + val.replace(/"/g, '&quot;') + '"');
      }
    }

    // For inputs, capture current value
    if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && !attrs.some(a => a.startsWith('value='))) {
      const val = el.value;
      if (val) attrs.push('value="' + val.replace(/"/g, '&quot;') + '"');
    }

    const children = [];
    for (const child of el.childNodes) {
      const s = serialize(child, depth + 1);
      if (s) children.push(s);
    }

    const inner = children.join('');
    if (!inner && !attrs.length && !['IMG', 'INPUT', 'BR', 'HR'].includes(tag)) return '';

    const tagLower = tag.toLowerCase();
    const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';

    if (['IMG', 'INPUT', 'BR', 'HR'].includes(tag)) {
      return '<' + tagLower + attrStr + '/>';
    }

    return '<' + tagLower + attrStr + '>' + inner + '</' + tagLower + '>';
  }

  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { dom: 'No element found matching: ' + (selector || 'body'), truncated: false };

  let dom = serialize(root, 0);
  const truncated = dom.length > maxLength;
  if (truncated) dom = dom.slice(0, maxLength) + '\\n<!-- truncated -->';

  return { dom, truncated };
}
`;

// Default limit: ~5000 tokens = ~20,000 characters
const DEFAULT_MAX_CHARS = 20_000;

export async function getContent(args: Record<string, unknown>): Promise<string> {
  const mode = (args.mode as string) || "tree";
  if (!["tree", "dom", "text"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Must be "tree", "dom", or "text".`);
  }

  const offset = Number(args.offset) || 0;
  const maxChars = Number(args.max_chars) || DEFAULT_MAX_CHARS;
  const page = await getBrowserPage();

  let content: string;
  let elements = 0;
  let truncated = false;
  let total: number | undefined;
  let hasMore = false;
  let endOffset: number | undefined;

  if (mode === "tree") {
    const cdp = await getCDPSession();
    const tree = await fetchAccessibilityTree(cdp, { maxChars: maxChars, offset });
    content = tree.content;
    truncated = tree.truncated;
    hasMore = tree.hasMore;
    total = tree.totalElements;
    endOffset = tree.endIndex;
    updateElementMap(tree.elements);
    elements = tree.elements.size;
  } else if (mode === "dom") {
    const selector = (args.selector as string) || undefined;
    const maxDepth = Number(args.max_depth) || 6;

    // Fetch full content for measuring total
    const options = JSON.stringify({ selector: selector ?? null, maxDepth, maxLength: 500_000 });
    const fullResult = await page.evaluate(`(${SIMPLIFIED_DOM_SCRIPT})(${options})`);
    const fullContent = (fullResult as { dom: string; truncated: boolean }).dom;
    total = fullContent.length;

    // Apply offset and limit
    content = fullContent.slice(offset, offset + maxChars);
    endOffset = offset + content.length;
    hasMore = endOffset < total;
    truncated = hasMore || (fullResult as { dom: string; truncated: boolean }).truncated;
    if (hasMore) {
      content += "\n<!-- truncated, use offset=" + endOffset + " to continue -->";
    }
  } else {
    // text mode
    const fullContent = await page.evaluate(() => document.body.innerText);
    total = fullContent.length;

    content = fullContent.slice(offset, offset + maxChars);
    endOffset = offset + content.length;
    hasMore = endOffset < total;
    truncated = hasMore;
    if (hasMore) {
      content += "\n... (truncated, use offset=" + endOffset + " to continue)";
    }
  }

  const result: BrowserContentResult = {
    type: "browser_content",
    url: page.url(),
    title: await page.title(),
    content,
    elements,
    truncated,
    token_estimate: Math.ceil(content.length / 4),
    offset: offset > 0 ? offset : undefined,
    total,
    has_more: hasMore || undefined,
    next_offset: hasMore ? endOffset : undefined,
  };

  return JSON.stringify(result);
}
