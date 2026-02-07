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
  const page = await getBrowserPage(sessionId!);

  // Inject marker element with fixed positioning (viewport coordinates)
  // Uses DOM APIs instead of innerHTML to work with Trusted Types CSP (e.g., Google login pages)
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

      // Create SVG using DOM APIs (avoids innerHTML for Trusted Types compatibility)
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("width", "24");
      svg.setAttribute("height", "24");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");

      const line1 = document.createElementNS(svgNS, "line");
      line1.setAttribute("x1", "12");
      line1.setAttribute("y1", "0");
      line1.setAttribute("x2", "12");
      line1.setAttribute("y2", "24");
      line1.setAttribute("stroke", "red");
      line1.setAttribute("stroke-width", "3");

      const line2 = document.createElementNS(svgNS, "line");
      line2.setAttribute("x1", "0");
      line2.setAttribute("y1", "12");
      line2.setAttribute("x2", "24");
      line2.setAttribute("y2", "12");
      line2.setAttribute("stroke", "red");
      line2.setAttribute("stroke-width", "3");

      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("cx", "12");
      circle.setAttribute("cy", "12");
      circle.setAttribute("r", "8");
      circle.setAttribute("stroke", "red");
      circle.setAttribute("stroke-width", "2");
      circle.setAttribute("fill", "none");

      svg.appendChild(line1);
      svg.appendChild(line2);
      svg.appendChild(circle);
      marker.appendChild(svg);
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
