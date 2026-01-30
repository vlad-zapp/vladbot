import type { ChatMessage } from "@vladbot/shared";
import { AVAILABLE_MODELS } from "@vladbot/shared";
import { getRuntimeSetting } from "../config/runtimeSettings.js";
import { compactSession } from "./compaction.js";

/**
 * Check if the session's context usage exceeds the compaction threshold
 * and auto-compact if so. Returns the compaction message if compaction
 * happened, or null if not needed.
 */
export async function autoCompactIfNeeded(
  sessionId: string,
  model: string,
  provider: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<ChatMessage | null> {
  const thresholdStr = await getRuntimeSetting("context_compaction_threshold");
  const threshold = parseInt(thresholdStr, 10) || 90;

  const modelInfo = AVAILABLE_MODELS.find((m) => m.id === model);
  if (!modelInfo || modelInfo.contextWindow <= 0) return null;

  const pct = (usage.inputTokens / modelInfo.contextWindow) * 100;
  if (pct < threshold) return null;

  try {
    const result = await compactSession(
      sessionId,
      model,
      provider,
      modelInfo.contextWindow,
    );
    return result.compactionMessage;
  } catch (err) {
    console.error("Auto-compaction failed:", err);
    return null;
  }
}
