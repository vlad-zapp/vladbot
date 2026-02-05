import type { ClassifiedError, SSEEvent, ToolCall } from "@vladbot/shared";

export interface ActiveStream {
  sessionId: string;
  assistantId: string;
  content: string;
  model: string;
  toolCalls: ToolCall[];
  hasToolCalls: boolean;
  done: boolean;
  aborted: boolean;
  error?: ClassifiedError;
  usage?: { inputTokens: number; outputTokens: number };
  requestBody?: unknown;
  subscribers: Set<(event: SSEEvent) => void>;
  /** Monotonically increasing ID to prevent stale timers from killing newer streams. */
  generation: number;
  /** AbortController for cancelling the LLM stream */
  abortController: AbortController;
}

const streams = new Map<string, ActiveStream>();
let nextGeneration = 0;

export function createStream(
  sessionId: string,
  assistantId: string,
  model: string,
): ActiveStream {
  // If there's already a stream for this session, clean it up
  streams.delete(sessionId);

  const stream: ActiveStream = {
    sessionId,
    assistantId,
    content: "",
    model,
    toolCalls: [],
    hasToolCalls: false,
    done: false,
    aborted: false,
    subscribers: new Set(),
    generation: ++nextGeneration,
    abortController: new AbortController(),
  };
  streams.set(sessionId, stream);
  return stream;
}

export function getStream(sessionId: string): ActiveStream | undefined {
  return streams.get(sessionId);
}

export function pushEvent(sessionId: string, event: SSEEvent): void {
  const stream = streams.get(sessionId);
  if (!stream) {
    return;
  }

  // If stream was aborted, don't accumulate any more content
  if (stream.aborted && event.type === "token") {
    return;
  }

  // Update accumulated state
  switch (event.type) {
    case "token":
      stream.content += event.data;
      break;
    case "tool_call":
      stream.toolCalls.push(event.data);
      break;
    case "done":
      stream.hasToolCalls = event.data.hasToolCalls;
      stream.done = true;
      break;
    case "error":
      stream.error = event.data;
      stream.done = true;
      break;
    case "usage":
      stream.usage = event.data;
      break;
    case "debug":
      if (event.data.direction === "request") {
        stream.requestBody = event.data.body;
      }
      break;
  }

  // Notify all subscribers
  for (const sub of stream.subscribers) {
    sub(event);
  }
}

export function removeStream(sessionId: string): void {
  const stream = streams.get(sessionId);
  if (stream) {
    stream.subscribers.clear();
    streams.delete(sessionId);
  }
}

/**
 * Schedule stream removal after a delay. The removal is cancelled if a
 * newer stream has been created for the same session in the meantime
 * (checked via generation counter).
 */
export function scheduleRemoval(sessionId: string, delayMs = 10_000): void {
  const stream = streams.get(sessionId);
  if (!stream) return;
  const expectedGen = stream.generation;
  setTimeout(() => {
    const current = streams.get(sessionId);
    if (current && current.generation === expectedGen) {
      removeStream(sessionId);
    }
  }, delayMs);
}

/**
 * Reset a stream for a new LLM round (tool loop continuation).
 * Keeps subscribers connected, clears accumulated content/toolCalls,
 * and updates the assistantId for the new message.
 * Returns the stream or null if no active stream exists.
 */
export function continueStream(
  sessionId: string,
  newAssistantId: string,
): ActiveStream | null {
  const stream = streams.get(sessionId);
  if (!stream) return null;

  stream.assistantId = newAssistantId;
  stream.content = "";
  stream.toolCalls = [];
  stream.hasToolCalls = false;
  stream.done = false;
  stream.error = undefined;
  stream.usage = undefined;
  stream.requestBody = undefined;

  return stream;
}
