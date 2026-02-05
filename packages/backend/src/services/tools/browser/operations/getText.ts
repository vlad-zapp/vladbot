import { getCDPSession, resolveElement } from "../connection.js";

export interface GetTextResult {
  type: "browser_get_text";
  elements: Array<{
    index: number;
    text: string;
    role: string;
    error?: string;
  }>;
}

/**
 * Get the full text content of elements by their indices.
 * Uses CDP to fetch innerText from the actual DOM nodes.
 */
export async function getText(args: Record<string, unknown>): Promise<string> {
  const elements = args.elements as number[] | undefined;
  if (!elements || !Array.isArray(elements) || elements.length === 0) {
    throw new Error("Missing required argument: elements (array of element indices)");
  }

  if (elements.length > 20) {
    throw new Error("Too many elements requested. Maximum is 20 per call.");
  }

  const cdp = await getCDPSession();
  const results: GetTextResult["elements"] = [];

  for (const index of elements) {
    try {
      const ref = resolveElement(index);

      // Use CDP to get the DOM node and its innerText
      const { object } = await cdp.send("DOM.resolveNode", {
        backendNodeId: ref.backendDOMNodeId,
      }) as { object: { objectId?: string } };

      if (!object.objectId) {
        results.push({
          index,
          text: ref.name, // Fallback to accessibility name
          role: ref.role,
        });
        continue;
      }

      // Get innerText via Runtime.callFunctionOn
      const { result } = await cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function() {
          // For input elements, return value; for others, return innerText
          if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
            return this.value || '';
          }
          return this.innerText || this.textContent || '';
        }`,
        returnByValue: true,
      }) as { result: { value?: string } };

      results.push({
        index,
        text: result.value ?? ref.name,
        role: ref.role,
      });

      // Release the object
      await cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        index,
        text: "",
        role: "unknown",
        error: msg,
      });
    }
  }

  const result: GetTextResult = {
    type: "browser_get_text",
    elements: results,
  };

  return JSON.stringify(result);
}
