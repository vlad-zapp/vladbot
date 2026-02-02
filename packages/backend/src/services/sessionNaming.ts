import type { Session } from "@vladbot/shared";
import { getProvider } from "./ai/ProviderFactory.js";
import { updateSession } from "./sessionStore.js";

/** Session IDs currently being named (prevents duplicate naming requests). */
const namingInProgress = new Set<string>();

/**
 * Generate a short descriptive name for a session based on the first user message.
 * Runs asynchronously — callers should fire-and-forget.
 * Returns the updated Session, or null if naming was skipped/failed.
 */
export async function generateSessionName(
  sessionId: string,
  firstMessageContent: string,
  providerName: string,
  model: string,
): Promise<Session | null> {
  if (namingInProgress.has(sessionId)) return null;
  namingInProgress.add(sessionId);

  try {
    const provider = getProvider(providerName);
    const { text } = await provider.generateResponse(
      [
        {
          role: "user",
          content: `What short name would you give to a conversation with this first message: ${firstMessageContent} (respond with name only, no details)`,
        },
      ],
      model,
    );

    let name = text.trim();
    name = name.replace(/^["']+|["']+$/g, "");
    if (name.length > 200) name = name.slice(0, 200);
    if (!name) return null;

    const session = await updateSession(sessionId, { title: name });
    return session;
  } catch (err) {
    console.error("Session naming failed:", err);
    return null;
  } finally {
    namingInProgress.delete(sessionId);
  }
}
