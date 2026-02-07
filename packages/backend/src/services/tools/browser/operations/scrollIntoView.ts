import { getBrowserPage, getCDPSession } from "../connection.js";
import type { CDPSession } from "patchright";

interface ElementPosition {
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
}

/**
 * Get element's bounding rect in VIEWPORT coordinates using getBoundingClientRect.
 * This is more reliable than CDP getBoxModel as it accounts for all CSS transforms, sticky elements, etc.
 */
async function getElementViewportRect(
  cdp: CDPSession,
  backendNodeId: number,
): Promise<ElementPosition | null> {
  try {
    // Resolve the backend node to a remote object
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId }) as { object: { objectId: string } };
    if (!object?.objectId) return null;

    // Call getBoundingClientRect on the element
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function() {
        const rect = this.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height };
      }`,
      returnByValue: true,
    }) as { result: { value: ElementPosition } };

    // Release the object
    await cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});

    return result?.value || null;
  } catch {
    return null;
  }
}

/**
 * Check if element is fully visible in viewport.
 * pos is already in viewport coordinates from getBoundingClientRect.
 */
function isFullyVisible(pos: ElementPosition, viewportHeight: number, margin = 50): boolean {
  return pos.top >= margin && pos.bottom <= viewportHeight - margin;
}

/**
 * Determine scroll direction: 1 for down, -1 for up, 0 if visible.
 * pos is in viewport coordinates.
 */
function getScrollDirection(pos: ElementPosition, viewportHeight: number): number {
  const viewportCenter = viewportHeight / 2;
  const elementCenter = (pos.top + pos.bottom) / 2;

  if (elementCenter > viewportCenter + viewportHeight / 4) {
    return 1; // scroll down (element is below center)
  } else if (elementCenter < viewportCenter - viewportHeight / 4) {
    return -1; // scroll up (element is above center)
  }
  return 0;
}

/**
 * Random delay between scroll steps (50-150ms).
 */
function randomDelay(): Promise<void> {
  const delay = 50 + Math.random() * 100;
  return new Promise((r) => setTimeout(r, delay));
}

/**
 * Wait for scroll to settle by checking if scrollY stops changing.
 */
async function waitForScrollSettle(page: Awaited<ReturnType<typeof getBrowserPage>>): Promise<void> {
  let lastScrollY = await page.evaluate(() => window.scrollY);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const currentScrollY = await page.evaluate(() => window.scrollY);
    if (currentScrollY === lastScrollY) {
      return; // Scroll has settled
    }
    lastScrollY = currentScrollY;
  }
}

/**
 * Random scroll amount (80-200 pixels).
 */
function randomScrollAmount(): number {
  return 80 + Math.random() * 120;
}

/**
 * Scroll element into view with human-like behavior.
 * Returns the element's final viewport coordinates for clicking.
 */
export async function scrollElementIntoView(
  backendNodeId: number,
  sessionId?: string,
): Promise<{ x: number; y: number } | null> {
  const page = await getBrowserPage(sessionId!);
  const cdp = await getCDPSession(sessionId!);
  const viewportHeight = await page.evaluate(() => window.innerHeight);

  // First check if element is already visible - no scrolling needed
  const initialRect = await getElementViewportRect(cdp, backendNodeId);
  if (!initialRect) return null;

  if (isFullyVisible(initialRect, viewportHeight, 50)) {
    // Already visible - return center coordinates (already in viewport coords)
    return {
      x: (initialRect.left + initialRect.right) / 2,
      y: (initialRect.top + initialRect.bottom) / 2,
    };
  }

  // Need to scroll - do it with human-like behavior
  const maxAttempts = 50; // Safety limit
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;

    // Get current element position in viewport coordinates
    const rect = await getElementViewportRect(cdp, backendNodeId);
    if (!rect) {
      return null; // Element not found / stale
    }

    // Check if element is fully visible with margin
    if (isFullyVisible(rect, viewportHeight, 80)) {
      // Element is visible - scroll a tiny bit more to center it better
      const elementCenter = (rect.top + rect.bottom) / 2;
      const viewportCenter = viewportHeight / 2;
      const diff = elementCenter - viewportCenter;

      if (Math.abs(diff) > 50) {
        // Center the element with a smooth small scroll
        const scrollAmount = diff * 0.3; // Don't fully center, just improve position
        await page.mouse.wheel(0, scrollAmount);
        await waitForScrollSettle(page);
      }

      // Wait a bit more for any animations/reflows to complete
      await new Promise((r) => setTimeout(r, 100));

      // Get FRESH final position (already in viewport coordinates!)
      const finalRect = await getElementViewportRect(cdp, backendNodeId);
      if (!finalRect) return null;

      return {
        x: (finalRect.left + finalRect.right) / 2,
        y: (finalRect.top + finalRect.bottom) / 2,
      };
    }

    // Determine scroll direction based on where element is in viewport
    const direction = getScrollDirection(rect, viewportHeight);
    if (direction === 0) {
      // Shouldn't happen if not fully visible, but handle it
      continue;
    }

    // Scroll with random amount
    const amount = randomScrollAmount() * direction;
    await page.mouse.wheel(0, amount);
    await waitForScrollSettle(page);
    await randomDelay();

    // Occasionally add extra micro-delays for more human-like behavior
    if (Math.random() < 0.2) {
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
  }

  // Max attempts reached - wait for settle and try to get position anyway
  await waitForScrollSettle(page);
  await new Promise((r) => setTimeout(r, 100));

  const finalRect = await getElementViewportRect(cdp, backendNodeId);
  if (!finalRect) return null;

  // Already in viewport coordinates
  return {
    x: (finalRect.left + finalRect.right) / 2,
    y: (finalRect.top + finalRect.bottom) / 2,
  };
}
