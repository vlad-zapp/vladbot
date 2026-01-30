import { getRuntimeSetting } from "../../config/runtimeSettings.js";

const DEFAULT_SYSTEM_PROMPT =
  "IMPORTANT: Never fabricate, invent, or guess visual information. " +
  "You may only describe what is on screen, in an image, or visually present " +
  "if you have actually received that information from a vision model. " +
  "If you have not examined the image through the vision tool, say so honestly. " +
  "Do not make up screen contents, times, UI states, text, or any other visual details.";

export async function getSystemPrompt(): Promise<string> {
  const custom = await getRuntimeSetting("system_prompt");
  return custom || DEFAULT_SYSTEM_PROMPT;
}

/** Synchronous fallback for contexts that can't await. */
export const SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;
