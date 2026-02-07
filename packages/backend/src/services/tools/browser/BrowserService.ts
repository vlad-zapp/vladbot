import type { MessagePart } from "@vladbot/shared";
import { AVAILABLE_MODELS, findModel } from "@vladbot/shared";
import { getSessionModel } from "../../sessionStore.js";
import { getSetting } from "../../settingsStore.js";
import { callSubLLMWithHistory } from "./SubLLM.js";
import {
  DESCRIBE_SYSTEM_PROMPT,
  buildDescribePrompt,
  buildDescribeContinuePrompt,
  FIND_ALL_SYSTEM_PROMPT,
  buildFindAllPrompt,
  buildFindAllContinuePrompt,
} from "./prompts.js";

// Import low-level operations
import { navigate } from "./operations/navigate.js";
import { click } from "./operations/click.js";
import { typeText } from "./operations/type.js";
import { pressKey } from "./operations/press.js";
import { scroll } from "./operations/scroll.js";
import { screenshot } from "./operations/screenshot.js";
import { getContent } from "./operations/getContent.js";

export interface BrowserServiceOptions {
  sessionId: string;
  model: string;
  provider: string;
}

export interface DescribeResult {
  description: string;
  pagesProcessed: number;
  totalElements: number;
}

export interface FoundElement {
  id: number;
  desc: string;
}

export interface FindAllResult {
  elements: FoundElement[];
  hasMore: boolean;
  nextOffset: number;
  total: number;
}

// Cache for find_all results
interface FindAllCache {
  query: string;
  elements: FoundElement[];
  timestamp: number;
}


export type ProgressCallback = (progress: number, total: number, message?: string) => void;

interface ContentResult {
  content: string;
  has_more: boolean;
  next_offset?: number;
  total?: number;
}

// Token estimation: ~4 chars per token
const CHARS_PER_TOKEN = 4;
// 8k tokens per page to fit detailed descriptions while still paginating large lists
const FIND_ALL_OUTPUT_LIMIT_TOKENS = 8000;
const FIND_ALL_OUTPUT_LIMIT_CHARS = FIND_ALL_OUTPUT_LIMIT_TOKENS * CHARS_PER_TOKEN;

/**
 * Browser Service - wraps low-level browser operations with sub-LLM intelligence.
 * Handles pagination internally for describe/find operations.
 */
export class BrowserService {
  private sessionId: string;
  private model: string;
  private provider: string;
  private findAllCache: FindAllCache | null = null;

  constructor(options: BrowserServiceOptions) {
    this.sessionId = options.sessionId;
    this.model = options.model;
    this.provider = options.provider;
  }

  /**
   * Describe what's on the current page.
   * Uses sub-LLM to analyze all pages and return a human-readable description.
   */
  async describe(question?: string, onProgress?: ProgressCallback): Promise<DescribeResult> {
    let pagesProcessed = 0;
    let totalElements = 0;
    let offset = 0;
    let hasMore = true;

    // Initialize conversation with system prompt
    let messages: MessagePart[] = [
      { role: "user", content: DESCRIBE_SYSTEM_PROMPT },
      { role: "assistant", content: "I understand. I will describe web pages concisely, always including element IDs in brackets." },
    ];

    let finalDescription = "";

    while (hasMore) {
      // Get page content
      const contentResult = await this.getContentInternal(offset);
      pagesProcessed++;
      totalElements = contentResult.total ?? totalElements;

      // Report progress
      if (onProgress) {
        const estimatedPages = contentResult.has_more ? pagesProcessed + 1 : pagesProcessed;
        console.log(`[BrowserService] Progress: ${pagesProcessed}/${estimatedPages}`);
        onProgress(pagesProcessed, estimatedPages, `Analyzing part ${pagesProcessed}...`);
      } else {
        console.log(`[BrowserService] No onProgress callback!`);
      }

      // Build prompt for this page
      const prompt = pagesProcessed === 1
        ? buildDescribePrompt(contentResult.content, question)
        : buildDescribeContinuePrompt(contentResult.content, question);

      // Call sub-LLM
      const result = await callSubLLMWithHistory(messages, prompt, {
        provider: this.provider,
        model: this.model,
      });

      messages = result.messages;
      finalDescription = result.text;

      // Check if more pages
      hasMore = contentResult.has_more;
      offset = contentResult.next_offset ?? 0;
    }

    return {
      description: finalDescription,
      pagesProcessed,
      totalElements,
    };
  }

  /**
   * Find all elements matching a query.
   * Results are cached and returned in paginated chunks to the main LLM.
   * Cache is reset when a different query is used.
   */
  async findAll(
    query: string,
    offset: number = 0,
    onProgress?: ProgressCallback,
  ): Promise<FindAllResult> {
    // Check if we need to perform a new search or use cached results
    const needsNewSearch = !this.findAllCache || this.findAllCache.query !== query;

    if (needsNewSearch) {
      // Reset cache and perform new search
      this.findAllCache = null;
      const elements = await this.performFindAllSearch(query, onProgress);
      this.findAllCache = {
        query,
        elements,
        timestamp: Date.now(),
      };
    }

    // Return paginated results from cache
    const allElements = this.findAllCache!.elements;

    // Calculate how many elements fit in the output limit
    // Each element is roughly: {"id": N, "desc": "..."} + comma + newline
    // Estimate ~50 chars base + description length
    let charCount = 0;
    let endOffset = offset;

    for (let i = offset; i < allElements.length; i++) {
      const elemChars = 50 + (allElements[i].desc?.length ?? 0);
      if (charCount + elemChars > FIND_ALL_OUTPUT_LIMIT_CHARS && i > offset) {
        // Would exceed limit, stop here (but include at least one element)
        break;
      }
      charCount += elemChars;
      endOffset = i + 1;
    }

    const pageElements = allElements.slice(offset, endOffset);
    const hasMore = endOffset < allElements.length;

    return {
      elements: pageElements,
      hasMore,
      nextOffset: hasMore ? endOffset : 0,
      total: allElements.length,
    };
  }

  /**
   * Internal: Perform the actual find_all search using sub-LLM.
   * Processes all pages and extracts all matching elements.
   */
  private async performFindAllSearch(
    query: string,
    onProgress?: ProgressCallback,
  ): Promise<FoundElement[]> {
    let pagesProcessed = 0;
    let offset = 0;
    let hasMore = true;

    // Initialize conversation with system prompt
    let messages: MessagePart[] = [
      { role: "user", content: FIND_ALL_SYSTEM_PROMPT },
      { role: "assistant", content: "I understand. I will find elements and return only a JSON array." },
    ];

    let allElements: FoundElement[] = [];

    while (hasMore) {
      // Get page content
      const contentResult = await this.getContentInternal(offset);
      pagesProcessed++;

      // Report progress
      if (onProgress) {
        const estimatedPages = contentResult.has_more ? pagesProcessed + 1 : pagesProcessed;
        onProgress(pagesProcessed, estimatedPages, `Searching part ${pagesProcessed}...`);
      }

      // Build prompt for this page
      const prompt = pagesProcessed === 1
        ? buildFindAllPrompt(contentResult.content, query)
        : buildFindAllContinuePrompt(contentResult.content, query);

      // Call sub-LLM
      const result = await callSubLLMWithHistory(messages, prompt, {
        provider: this.provider,
        model: this.model,
      });

      messages = result.messages;

      // Parse the JSON array from the response
      console.log(`[BrowserService] find_all page ${pagesProcessed} response (${result.text.length} chars):`, result.text.substring(0, 500));
      try {
        const parsed = this.parseElementsFromResponse(result.text);
        console.log(`[BrowserService] Parsed ${parsed.length} elements from page ${pagesProcessed}`);
        allElements = parsed;
      } catch (e) {
        console.error("[BrowserService] Failed to parse find_all response:", e);
        // Keep previous elements if parsing fails
      }

      // Check if more pages
      hasMore = contentResult.has_more;
      offset = contentResult.next_offset ?? 0;
    }

    return allElements;
  }

  /**
   * Parse elements array from LLM response.
   * Handles various formats the LLM might return.
   */
  private parseElementsFromResponse(text: string): FoundElement[] {
    // Strip markdown code block markers if present
    let cleaned = text
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    // Try to extract JSON array from the response
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn("[BrowserService] No JSON array found in response. Full response:", text.substring(0, 500));
      return [];
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) {
        console.warn("[BrowserService] Parsed JSON is not an array:", typeof parsed);
        return [];
      }

      // Validate and normalize elements
      const elements = parsed
        .filter((el: unknown): el is { id: number; desc?: string } =>
          typeof el === "object" && el !== null && typeof (el as Record<string, unknown>).id === "number"
        )
        .map((el) => ({
          id: el.id,
          desc: String(el.desc ?? ""),
        }));

      if (elements.length !== parsed.length) {
        console.warn(`[BrowserService] Filtered out ${parsed.length - elements.length} invalid elements`);
      }

      return elements;
    } catch (e) {
      console.error("[BrowserService] JSON parse error:", e);
      console.error("[BrowserService] Attempted to parse:", jsonMatch[0].substring(0, 500));
      return [];
    }
  }

  /**
   * Clear the find_all cache (called when page content changes).
   */
  clearFindAllCache(): void {
    this.findAllCache = null;
  }

  /**
   * Navigate to a URL.
   * Passthrough to low-level operation.
   */
  async navigate(url: string, waitUntil?: string): Promise<string> {
    this.clearFindAllCache();
    return navigate({ url, wait_until: waitUntil }, this.sessionId);
  }

  /**
   * Click an element by ID.
   * Passthrough to low-level operation.
   */
  async click(elementId: number): Promise<string> {
    return click({ element: elementId }, this.sessionId);
  }

  /**
   * Type text into an element.
   * Passthrough to low-level operation.
   */
  async type(text: string, elementId?: number, clearFirst?: boolean): Promise<string> {
    return typeText({ text, element: elementId, clear_first: clearFirst }, this.sessionId);
  }

  /**
   * Press a keyboard key.
   * Passthrough to low-level operation.
   */
  async pressKey(key: string): Promise<string> {
    return pressKey({ key }, this.sessionId);
  }

  /**
   * Scroll the viewport.
   * Passthrough to low-level operation.
   */
  async scroll(direction?: string, amount?: string, toElement?: number): Promise<string> {
    return scroll({ direction, amount, to_element: toElement }, this.sessionId);
  }

  /**
   * Take a screenshot.
   * Passthrough to low-level operation.
   */
  async screenshot(selector?: string): Promise<string> {
    return screenshot({ selector }, this.sessionId);
  }

  /**
   * Internal: Get content with parsed result.
   * Uses 80% of the model's context window for the page limit.
   */
  private async getContentInternal(offset: number = 0): Promise<ContentResult> {
    // Calculate max chars based on 80% of model's context window
    // ~4 chars per token, so contextWindow * 0.8 * 4
    const modelInfo = findModel(this.model);
    const contextWindow = modelInfo?.contextWindow ?? 65_536; // fallback to 64K
    const maxChars = Math.floor(contextWindow * 0.8 * 4);

    const resultJson = await getContent({ mode: "tree", offset, max_chars: maxChars }, this.sessionId);
    const result = JSON.parse(resultJson) as {
      content: string;
      has_more?: boolean;
      next_offset?: number;
      total?: number;
    };

    return {
      content: result.content,
      has_more: result.has_more ?? false,
      next_offset: result.next_offset,
      total: result.total,
    };
  }
}

// Singleton instance cache per session
const serviceCache = new Map<string, BrowserService>();

/**
 * Get or create a BrowserService instance for a session.
 */
export function getBrowserService(options: BrowserServiceOptions): BrowserService {
  const key = `${options.sessionId}-${options.provider}-${options.model}`;
  let service = serviceCache.get(key);
  if (!service) {
    service = new BrowserService(options);
    serviceCache.set(key, service);
  }
  return service;
}

/**
 * Clean up BrowserService cache entries for a session.
 */
export function cleanupBrowserServiceCache(sessionId: string): void {
  for (const [key] of serviceCache) {
    if (key.startsWith(`${sessionId}-`)) {
      serviceCache.delete(key);
    }
  }
}

/**
 * Resolve model info for a session.
 * Returns { model, provider } or throws if session not found.
 */
export async function resolveSessionModelInfo(
  sessionId: string,
): Promise<{ model: string; provider: string }> {
  const storedModel = await getSessionModel(sessionId);
  if (storedModel === null) {
    throw new Error("Session not found");
  }

  let modelInfo = storedModel ? findModel(storedModel) : undefined;
  if (!modelInfo) {
    const defaultModelSetting = await getSetting("default_model");
    modelInfo =
      (defaultModelSetting && findModel(defaultModelSetting)) ||
      AVAILABLE_MODELS[0];
  }

  return {
    model: modelInfo.id,
    provider: modelInfo.provider,
  };
}

/**
 * Get a BrowserService for a session, resolving model info automatically.
 */
export async function getBrowserServiceForSession(
  sessionId: string,
): Promise<BrowserService> {
  const { model, provider } = await resolveSessionModelInfo(sessionId);
  return getBrowserService({ sessionId, model, provider });
}
