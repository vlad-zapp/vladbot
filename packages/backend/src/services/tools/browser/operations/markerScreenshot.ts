import { getBrowserPage } from "../connection.js";
import { saveSessionFile } from "../../../sessionFiles.js";

/**
 * Take a viewport screenshot with a red cross marker at the specified coordinates.
 * The marker is injected into the page temporarily, then removed after capture.
 * Assumes the element has already been scrolled into view.
 */
export async function takeMarkerScreenshot(
  x: number,
  y: number,
  sessionId?: string,
): Promise<{ image_url?: string; image_base64?: string }> {
  const page = await getBrowserPage();

  // Inject marker element with fixed positioning (viewport coordinates)
  const markerId = `_marker_${Date.now()}`;
  await page.evaluate(
    ({ id, x, y }) => {
      const marker = document.createElement("div");
      marker.id = id;
      marker.style.cssText = `
        position: fixed;
        left: ${x - 12}px;
        top: ${y - 12}px;
        width: 24px;
        height: 24px;
        pointer-events: none;
        z-index: 2147483647;
      `;
      marker.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <line x1="12" y1="0" x2="12" y2="24" stroke="red" stroke-width="3"/>
          <line x1="0" y1="12" x2="24" y2="12" stroke="red" stroke-width="3"/>
          <circle cx="12" cy="12" r="8" stroke="red" stroke-width="2" fill="none"/>
        </svg>
      `;
      document.body.appendChild(marker);
    },
    { id: markerId, x, y },
  );

  // Take viewport screenshot
  const buffer = await page.screenshot({ type: "jpeg", quality: 75 });

  // Remove marker
  await page.evaluate((id) => {
    const marker = document.getElementById(id);
    if (marker) marker.remove();
  }, markerId);

  // Return as URL or base64
  if (sessionId) {
    const filename = saveSessionFile(sessionId, Buffer.from(buffer), "jpg");
    return { image_url: `/api/sessions/${sessionId}/files/${filename}` };
  } else {
    return { image_base64: `data:image/jpeg;base64,${Buffer.from(buffer).toString("base64")}` };
  }
}
