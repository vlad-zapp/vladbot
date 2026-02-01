import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  ClassifiedError,
  SSEEvent,
  ToolCall,
  ToolResult,
} from "@vladbot/shared";
import type { DebugEntry } from "../services/api.js";
import {
  streamChat,
  fetchSession,
  fetchMessages,
  saveMessage,
  compactSessionApi,
  switchModelApi,
  subscribeToStream,
  approveToolCallsApi,
  denyToolCallsApi,
  watchSessionApi,
  unwatchSessionApi,
} from "../services/api.js";
import { wsClient } from "../services/wsClient.js";
import type { SnapshotData } from "../services/api.js";

/** Reconstruct debug log entries from messages that have stored llmRequest/llmResponse. */
function reconstructDebugLog(msgs: ChatMessage[]): DebugEntry[] {
  const entries: DebugEntry[] = [];
  for (const msg of msgs) {
    if (msg.role !== "assistant") continue;
    if (msg.llmRequest) {
      entries.push({ timestamp: msg.timestamp, direction: "request", body: msg.llmRequest, messageId: msg.id });
    }
    if (msg.llmResponse) {
      entries.push({ timestamp: msg.timestamp, direction: "response", body: msg.llmResponse, messageId: msg.id });
    }
  }
  return entries;
}

/**
 * Merge DB messages with local state by ID. Keeps the local object reference
 * when the visible content hasn't changed, preventing unnecessary React
 * re-renders and layout shifts (scroll jumps).
 *
 * Local messages that are older than the DB page range (loaded via infinite
 * scroll) are preserved so they don't vanish when a post-stream reload
 * fetches only the latest page.
 */
export function mergeMessages(local: ChatMessage[], db: ChatMessage[]): ChatMessage[] {
  const dbIds = new Set(db.map((m) => m.id));
  const localMap = new Map(local.map((m) => [m.id, m]));

  // Keep local-only messages that come before the DB range (older messages
  // loaded via infinite scroll that aren't in the latest DB page).
  const olderLocal: ChatMessage[] = [];
  for (const m of local) {
    if (dbIds.has(m.id)) break;   // Reached the DB range
    olderLocal.push(m);
  }

  const merged = db.map((dbMsg) => {
    const localMsg = localMap.get(dbMsg.id);
    if (!localMsg) return dbMsg;
    // If the visible content is identical AND the local version already has
    // all the metadata the DB version has, keep the local reference to avoid
    // unnecessary re-renders. Otherwise take the richer DB version.
    if (
      localMsg.content === dbMsg.content &&
      localMsg.role === dbMsg.role &&
      localMsg.approvalStatus === dbMsg.approvalStatus &&
      (localMsg.toolCalls?.length ?? 0) === (dbMsg.toolCalls?.length ?? 0) &&
      (localMsg.toolResults?.length ?? 0) === (dbMsg.toolResults?.length ?? 0) &&
      (localMsg.images?.length ?? 0) === (dbMsg.images?.length ?? 0) &&
      (localMsg.tokenCount != null || dbMsg.tokenCount == null) &&
      (localMsg.rawTokenCount != null || dbMsg.rawTokenCount == null)
    ) {
      return localMsg;
    }
    return dbMsg;
  });

  return olderLocal.length > 0 ? [...olderLocal, ...merged] : merged;
}

/** Encapsulates all state for the currently streaming session.
 *  Only one session streams at a time — this replaces the old scattered
 *  streamingSessionRef, abortRef, and activeStreamRef. */
interface StreamState {
  /** The session ID that owns this stream */
  sessionId: string;
  /** Whether the user has requested to abort this stream */
  aborted: boolean;
  /** Live stream metadata for restoring UI when switching back */
  activeStream: {
    assistantId: string;
    content: string;
    model: string;
    toolCalls: ToolCall[];
  } | null;
}

const DEFAULT_PAGE_SIZE = 30;

export function useChat(
  activeSessionId: string | null,
  onEnsureSession: (title?: string) => Promise<string>,
  onUpdateSessionTitle: (id: string, title: string) => void,
  initialAutoApprove?: boolean,
  onAutoApproveChange?: (value: boolean) => void,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [debugLog, setDebugLog] = useState<DebugEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<{ inputTokens: number; outputTokens: number } | null>(null);
  const [autoApprove, setAutoApproveState] = useState(false);
  const [compactionError, setCompactionError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const skipLoadRef = useRef(false);
  /** Synchronous guard against double-send (set true before first await). */
  const sendingRef = useRef(false);
  /** Single source of truth for the current stream. Encapsulates session ID,
   *  abort flag, and live stream metadata. Null when nothing is streaming. */
  const streamStateRef = useRef<StreamState | null>(null);
  const autoApproveRef = useRef(autoApprove);
  autoApproveRef.current = autoApprove;
  const isCompactingRef = useRef(isCompacting);
  isCompactingRef.current = isCompacting;
  const tokenUsageRef = useRef(tokenUsage);
  tokenUsageRef.current = tokenUsage;

  // Cache token usage per session so the broom shows correct values after switching
  const tokenUsageCacheRef = useRef<Map<string, { inputTokens: number; outputTokens: number }>>(new Map());


  // Sync auto-approve from parent (useSettings). Updates flow in when settings
  // change — either from the initial fetch or from a cross-client push event.
  useEffect(() => {
    if (initialAutoApprove == null) return;
    setAutoApproveState(initialAutoApprove);
    autoApproveRef.current = initialAutoApprove;
  }, [initialAutoApprove]);

  const setAutoApprove = useCallback((updater: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof updater === "function" ? updater(autoApproveRef.current) : updater;
    setAutoApproveState(next);
    autoApproveRef.current = next;
    onAutoApproveChange?.(next);
  }, [onAutoApproveChange]);

  // Subscribe to a stream (active or reconnecting) with standard callbacks.
  // Tracks the current assistant message ID from onSnapshot so that onDone
  // can auto-approve tool calls without a flash of pending buttons.
  const subscribeStreamCallbacks = useCallback(
    (sid: string, staleCheck: () => boolean) => {
      let assistantId = "";
      return {
        onSnapshot: (snap: { assistantId: string; content: string; model: string; toolCalls: ToolCall[] }) => {
          if (staleCheck()) return;
          assistantId = snap.assistantId;
          setMessages((prev) => {
            const existing = prev.find((m) => m.id === snap.assistantId);
            if (existing) {
              // Don't overwrite a message that has content/toolCalls with an
              // empty snapshot (happens when subscribing during tool execution —
              // the approve handler creates a stream with the original message's
              // ID but empty state).
              const snapEmpty = !snap.content && snap.toolCalls.length === 0;
              const existingHasData = !!(existing.content || existing.toolCalls?.length);
              if (snapEmpty && existingHasData) return prev;
              return prev.map((m) =>
                m.id === snap.assistantId
                  ? { ...m, content: snap.content, toolCalls: snap.toolCalls.length > 0 ? snap.toolCalls : undefined }
                  : m,
              );
            }
            return [
              ...prev,
              {
                id: snap.assistantId,
                role: "assistant" as const,
                content: snap.content,
                model: snap.model,
                timestamp: Date.now(),
                toolCalls: snap.toolCalls.length > 0 ? snap.toolCalls : undefined,
              },
            ];
          });
          setIsStreaming(true);
        },
        onToken: (token: string) => {
          if (staleCheck()) return;
          setMessages((prev) =>
            prev.map((m, i) =>
              i === prev.length - 1 && m.role === "assistant"
                ? { ...m, content: m.content + token }
                : m,
            ),
          );
        },
        onToolCall: (toolCall: ToolCall) => {
          if (staleCheck()) return;
          setMessages((prev) =>
            prev.map((m, i) =>
              i === prev.length - 1 && m.role === "assistant"
                ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] }
                : m,
            ),
          );
        },
        onToolResult: (result: ToolResult) => {
          if (staleCheck()) return;
          // Find the assistant message with the matching tool call
          setMessages((prev) =>
            prev.map((m) => {
              if (m.role !== "assistant" || !m.toolCalls?.some((tc) => tc.id === result.toolCallId)) return m;
              return { ...m, toolResults: [...(m.toolResults ?? []), result] };
            }),
          );
        },
        onDone: (hasToolCalls: boolean) => {
          if (staleCheck()) return;

          if (hasToolCalls) {
            setMessages((prev) =>
              prev.map((m, i) =>
                i === prev.length - 1 && m.role === "assistant"
                  ? { ...m, approvalStatus: "pending" as const }
                  : m,
              ),
            );
          }
          setIsStreaming(false);
          // Reload latest page from DB to get accurate state.
          // Merge by ID to preserve object identity for unchanged messages,
          // avoiding unnecessary re-renders and scroll jumps.
          fetchMessages(sid)
            .then((result) => {
              if (!staleCheck()) {
                setMessages((prev) => mergeMessages(prev, result.messages));
                setHasMore(result.hasMore);
                setDebugLog(reconstructDebugLog(result.messages));
              }
            })
            .catch(() => {});
        },
        onAutoApproved: (messageId: string) => {
          if (staleCheck()) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === messageId
                ? { ...m, approvalStatus: "approved" as const }
                : m,
            ),
          );
        },
        onCompaction: (compactionMsg: ChatMessage) => {
          if (staleCheck()) return;
          setMessages((prev) => [...prev, compactionMsg]);
        },
        onError: (error: ClassifiedError) => {
          if (staleCheck()) return;
          setMessages((prev) =>
            prev.map((m, i) =>
              i === prev.length - 1 && m.role === "assistant"
                ? { ...m, content: `Error: ${error.message}` }
                : m,
            ),
          );
          setIsStreaming(false);
        },
        onUsage: (usage: { inputTokens: number; outputTokens: number }) => {
          if (staleCheck()) return;
          setTokenUsage(usage);
          tokenUsageCacheRef.current.set(sid, usage);
        },
      };
    },
    [],
  );

  // Load messages when active session changes, watch the session for
  // cross-client sync (new messages, stream events from other clients).
  useEffect(() => {
    let stale = false;
    let unsubPush: (() => void) | null = null;

    // Update sessionIdRef so stale checks in sendMessage/streamTurn work
    // when the user switches sessions during streaming.
    sessionIdRef.current = activeSessionId;

    // Derive isStreaming for the new session: if a local stream is active
    // for a DIFFERENT session, hide the indicator. If it's for THIS session
    // (e.g., switching back), show it.
    const streamingHere = streamStateRef.current?.sessionId === activeSessionId;
    setIsStreaming(!!streamingHere);

    if (!activeSessionId) {
      setMessages([]);
      setDebugLog([]);
      setTokenUsage(null);
      setHasMore(false);
      setIsLoadingSession(false);
      return;
    }

    // When sendMessage creates a new session it sets skipLoadRef = true so we
    // don't wipe the messages it's about to add.  We intentionally never reset
    // the flag here — sendMessage resets it in its finally block, after the
    // effect has already fired.  This also avoids React StrictMode's
    // double-invocation consuming the flag on the first run.
    const shouldLoad = !skipLoadRef.current;

    if (shouldLoad) {
      setMessages([]);
      setDebugLog([]);
      setTokenUsage(null);
      setHasMore(false);
      setIsLoadingSession(true);
    }
    const sid = activeSessionId;

    // Watch the session so the backend pushes events from other clients
    watchSessionApi(sid).catch(() => {});

    // Re-watch on reconnect (server forgets watchers when the WS drops)
    const unsubConn = wsClient.onConnectionChange((connected) => {
      if (connected && !stale) {
        watchSessionApi(sid).catch(() => {});
      }
    });

    // Listen for push events on this session.
    // Stream events (token, done, etc.) are only handled here for CROSS-CLIENT
    // streams. When a local stream is active, streamChat has its own push
    // listener that handles these events via streamTurn callbacks.
    unsubPush = wsClient.onPush(sid, (event: SSEEvent) => {
      if (stale) return;

      // new_message is always relevant (from other clients)
      if (event.type === "new_message") {
        setMessages((prev) => {
          if (prev.some((m) => m.id === event.data.id)) return prev;
          return [...prev, event.data];
        });
        return;
      }

      // Skip stream events when a local stream is handling them for THIS session
      if (streamStateRef.current?.sessionId === sid) return;

      switch (event.type) {
        case "snapshot": {
          const snap = event.data as { assistantId: string; content: string; model: string; toolCalls: ToolCall[] };
          setMessages((prev) => {
            const existing = prev.find((m) => m.id === snap.assistantId);
            if (existing) {
              if (!snap.content && snap.toolCalls.length === 0 && (existing.content || existing.toolCalls?.length)) return prev;
              return prev.map((m) =>
                m.id === snap.assistantId
                  ? { ...m, content: snap.content, toolCalls: snap.toolCalls.length > 0 ? snap.toolCalls : undefined }
                  : m,
              );
            }
            return [
              ...prev,
              {
                id: snap.assistantId,
                role: "assistant" as const,
                content: snap.content,
                model: snap.model,
                timestamp: Date.now(),
                toolCalls: snap.toolCalls.length > 0 ? snap.toolCalls : undefined,
              },
            ];
          });
          setIsStreaming(true);
          break;
        }
        case "token":
          setMessages((prev) =>
            prev.map((m, i) =>
              i === prev.length - 1 && m.role === "assistant"
                ? { ...m, content: m.content + event.data }
                : m,
            ),
          );
          break;
        case "tool_call":
          setMessages((prev) =>
            prev.map((m, i) =>
              i === prev.length - 1 && m.role === "assistant"
                ? { ...m, toolCalls: [...(m.toolCalls ?? []), event.data] }
                : m,
            ),
          );
          break;
        case "tool_result":
          setMessages((prev) =>
            prev.map((m) => {
              if (m.role !== "assistant" || !m.toolCalls?.some((tc) => tc.id === event.data.toolCallId)) return m;
              return { ...m, toolResults: [...(m.toolResults ?? []), event.data] };
            }),
          );
          break;
        case "auto_approved":
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.data.messageId
                ? { ...m, approvalStatus: "approved" as const }
                : m,
            ),
          );
          break;
        case "done":
          setIsStreaming(false);
          fetchMessages(sid)
            .then((result) => {
              if (!stale) {
                setMessages((prev) => mergeMessages(prev, result.messages));
                setHasMore(result.hasMore);
                setDebugLog(reconstructDebugLog(result.messages));
              }
            })
            .catch(() => {});
          break;
        case "error":
          setMessages((prev) =>
            prev.map((m, i) =>
              i === prev.length - 1 && m.role === "assistant"
                ? { ...m, content: `Error: ${event.data.message}` }
                : m,
            ),
          );
          setIsStreaming(false);
          break;
        case "usage":
          setTokenUsage(event.data);
          tokenUsageCacheRef.current.set(sid, event.data);
          break;
        case "compaction_started":
          setIsCompacting(true);
          setCompactionError(null);
          break;
        case "compaction":
          setMessages((prev) => [...prev, event.data]);
          setIsCompacting(false);
          break;
        case "compaction_error":
          setCompactionError(event.data.error);
          setTimeout(() => setCompactionError(null), 5000);
          setIsCompacting(false);
          break;
        case "approval_changed":
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.data.messageId
                ? { ...m, approvalStatus: event.data.approvalStatus as "approved" | "denied" }
                : m,
            ),
          );
          break;
      }
    });

    // Load last page of messages + session metadata in parallel
    if (shouldLoad) {
      Promise.all([
        fetchMessages(sid),
        fetchSession(sid),
      ])
        .then(async ([msgResult, session]) => {
          if (stale) return;

          let msgs = msgResult.messages;

          // Check for in-memory active stream (session switch without refresh)
          const ss = streamStateRef.current;
          if (ss?.sessionId === sid && ss.activeStream) {
            const ls = ss.activeStream;
            if (!msgs.some((m) => m.id === ls.assistantId)) {
              msgs = [
                ...msgs,
                {
                  id: ls.assistantId,
                  role: "assistant" as const,
                  content: ls.content,
                  model: ls.model,
                  timestamp: Date.now(),
                  toolCalls: ls.toolCalls.length > 0 ? ls.toolCalls : undefined,
                },
              ];
            }
          }


          setMessages(msgs);
          setHasMore(msgResult.hasMore);

          // Reconstruct debug logs from stored llmRequest/llmResponse
          setDebugLog(reconstructDebugLog(msgs));

          // Restore token usage: prefer in-memory cache, fall back to DB-persisted value
          const cachedUsage = tokenUsageCacheRef.current.get(sid);
          if (cachedUsage) {
            setTokenUsage(cachedUsage);
          } else if (session.tokenUsage) {
            setTokenUsage(session.tokenUsage);
          }
          setIsLoadingSession(false);
        })
        .catch((err) => {
          console.error("Failed to load session:", sid, err);
          if (!stale) {
            setIsLoadingSession(false);
          }
        });
    }

    return () => {
      stale = true;
      if (unsubPush) unsubPush();
      unsubConn();
      unwatchSessionApi(sid).catch(() => {});
    };
  }, [activeSessionId]);

  const streamTurn = useCallback(
    async (
      sessionId?: string,
      userMsgId?: string,
    ): Promise<{ toolCalls: ToolCall[]; hasToolCalls: boolean }> => {
      let collectedToolCalls: ToolCall[] = [];
      let hasToolCalls = false;
      let fullContent = "";
      let currentAssistantId = "";

      // Mark which session is streaming locally so the push handler
      // doesn't double-process stream events for this session.
      // Encapsulates session ID, abort flag, and live stream metadata.
      if (sessionId) {
        streamStateRef.current = {
          sessionId,
          aborted: false,
          activeStream: {
            assistantId: "",
            content: "",
            model: "",
            toolCalls: [],
          },
        };
      }

      await streamChat(
        { sessionId: sessionId! },
        {
          onSnapshot: (snap: SnapshotData) => {
            if (streamStateRef.current?.aborted) return;
            // New round started — create/update the new assistant message
            currentAssistantId = snap.assistantId;
            fullContent = snap.content;
            collectedToolCalls = [];
            const as = streamStateRef.current?.activeStream;
            if (as) {
              as.assistantId = snap.assistantId;
              as.content = snap.content;
              as.toolCalls = [];
            }
            setMessages((prev) => {
              const existing = prev.find((m) => m.id === snap.assistantId);
              if (existing) {
                const snapEmpty = !snap.content && snap.toolCalls.length === 0;
                const existingHasData = !!(existing.content || existing.toolCalls?.length);
                if (snapEmpty && existingHasData) return prev;
                return prev.map((m) =>
                  m.id === snap.assistantId
                    ? { ...m, content: snap.content, toolCalls: snap.toolCalls.length > 0 ? snap.toolCalls : undefined }
                    : m,
                );
              }
              return [
                ...prev,
                {
                  id: snap.assistantId,
                  role: "assistant" as const,
                  content: snap.content,
                  model: snap.model,
                  timestamp: Date.now(),
                  toolCalls: snap.toolCalls.length > 0 ? snap.toolCalls : undefined,
                },
              ];
            });
          },
          onToken: (token) => {
            if (streamStateRef.current?.aborted) return;
            fullContent += token;
            const as = streamStateRef.current?.activeStream;
            if (as?.assistantId === currentAssistantId) {
              as.content = fullContent;
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === currentAssistantId
                  ? { ...m, content: fullContent }
                  : m,
              ),
            );
          },
          onToolCall: (toolCall) => {
            if (streamStateRef.current?.aborted) return;
            collectedToolCalls.push(toolCall);
            const as = streamStateRef.current?.activeStream;
            if (as?.assistantId === currentAssistantId) {
              as.toolCalls = [...collectedToolCalls];
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === currentAssistantId
                  ? {
                      ...m,
                      toolCalls: [...collectedToolCalls],
                    }
                  : m,
              ),
            );
          },
          onToolResult: (result) => {
            if (streamStateRef.current?.aborted) return;
            setMessages((prev) =>
              prev.map((m) => {
                if (m.role !== "assistant" || !m.toolCalls?.some((tc) => tc.id === result.toolCallId)) return m;
                return { ...m, toolResults: [...(m.toolResults ?? []), result] };
              }),
            );
          },
          onAutoApproved: (messageId) => {
            if (streamStateRef.current?.aborted) return;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === messageId
                  ? { ...m, approvalStatus: "approved" as const }
                  : m,
              ),
            );
          },
          onDone: (htc) => {
            hasToolCalls = htc;
            if (htc) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantId
                    ? { ...m, approvalStatus: "pending" as const }
                    : m,
                ),
              );
            }
          },
          onError: (error) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === currentAssistantId
                  ? { ...m, content: `Error: ${error.message}` }
                  : m,
              ),
            );
          },
          onDebug: (entry) => {
            const taggedEntry = {
              ...entry,
              messageId: userMsgId ?? currentAssistantId,
            };
            setDebugLog((prev) => [...prev, taggedEntry]);
          },
          onUsage: (usage) => {
            setTokenUsage(usage);
            if (sessionId) {
              tokenUsageCacheRef.current.set(sessionId, usage);
            }
            // Update local messages with raw token counts immediately
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id === currentAssistantId) {
                  return { ...m, rawTokenCount: usage.outputTokens };
                }
                // Update the user message that triggered this turn
                if (m.id === userMsgId && m.role === "user" && !m.rawTokenCount) {
                  return { ...m, rawTokenCount: usage.inputTokens };
                }
                return m;
              }),
            );
          },
        },
      );

      // Synthesize a response debug entry
      setDebugLog((prev) => [
        ...prev,
        {
          timestamp: Date.now(),
          direction: "response" as const,
          body: {
            content: fullContent,
            toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
          },
          messageId: currentAssistantId,
        },
      ]);

      return { toolCalls: collectedToolCalls, hasToolCalls };
    },
    [],
  );

  const sendMessage = useCallback(
    async (content: string, images?: string[]) => {
      if (sendingRef.current) return;
      // Synchronous guard: prevent a second call from entering while
      // awaiting onEnsureSession / saveMessage (before React re-renders).
      sendingRef.current = true;

      // Ensure we have a session
      let sessionId = activeSessionId;
      if (!sessionId) {
        const title = content.slice(0, 50);
        skipLoadRef.current = true;
        sessionId = await onEnsureSession(title);
      }
      sessionIdRef.current = sessionId;

      // Auto-title on first message
      if (messages.length === 0) {
        const title = content.slice(0, 50);
        onUpdateSessionTitle(sessionId, title);
      }

      const userMsg: ChatMessage = {
        id: "",
        role: "user",
        content,
        images: images?.length ? images : undefined,
        timestamp: Date.now(),
      };

      try {
        // Save user message — backend generates the ID
        const resp = await saveMessage(sessionId, userMsg);
        userMsg.id = resp.id!;
        if (resp.images?.length) {
          userMsg.images = resp.images;
        }
        if (resp.tokenCount != null) {
          userMsg.tokenCount = resp.tokenCount;
        }

        setMessages((prev) => [...prev, userMsg]);
        setIsStreaming(true);

        // Backend generates assistantId and sends it via the snapshot event;
        // the onSnapshot callback in streamTurn creates the assistant message.
        await streamTurn(sessionId, userMsg.id);

        // Reload from DB to pick up server-computed fields (tokenCount, rawTokenCount).
        // Guard against stale session: user may have switched sessions during streaming.
        if (sessionIdRef.current === sessionId) {
          fetchMessages(sessionId)
            .then((result) => {
              if (sessionIdRef.current !== sessionId) return; // stale by the time fetch resolves
              setMessages((prev) => mergeMessages(prev, result.messages));
              setHasMore(result.hasMore);
            })
            .catch(() => {});
        }
      } catch (err) {
        // Don't pollute the new session with errors from the old one
        if (sessionIdRef.current === sessionId) {
          const errMsg = err instanceof Error ? err.message : "Unknown error";
          setMessages((prev) => {
            // Find the last assistant message (created by onSnapshot) and show the error
            const lastAssistant = [...prev].reverse().find((m) => m.role === "assistant");
            if (lastAssistant) {
              return prev.map((m) =>
                m.id === lastAssistant.id
                  ? { ...m, content: `Error: ${errMsg}` }
                  : m,
              );
            }
            // No assistant message yet — append the user message + error
            return [
              ...prev,
              ...(prev.some((m) => m.id === userMsg.id) ? [] : [userMsg]),
              {
                id: `err-${Date.now()}`,
                role: "assistant" as const,
                content: `Error: ${errMsg}`,
                timestamp: Date.now(),
              },
            ];
          });
        }
      } finally {
        sendingRef.current = false;
        // Release stream state for this session
        if (streamStateRef.current?.sessionId === sessionId) {
          streamStateRef.current = null;
        }
        // Only reset UI/skip state if we're still on the same session.
        if (sessionIdRef.current === sessionId) {
          skipLoadRef.current = false;
          setIsStreaming(false);
        }
      }
    },
    [
      messages,
      activeSessionId,
      streamTurn,
      onEnsureSession,
      onUpdateSessionTitle,
    ],
  );

  const compactContext = useCallback(
    async () => {
      const sessionId = activeSessionId ?? sessionIdRef.current;
      if (!sessionId || streamStateRef.current || isCompactingRef.current) return;

      try {
        // Server pushes compaction_started/compaction/compaction_error to all clients
        await compactSessionApi(sessionId);
      } catch (err) {
        // RPC-level error (network, validation) — push events handle compaction lifecycle
        console.error("Manual compaction request failed:", err);
      }
    },
    [activeSessionId],
  );

  const switchModel = useCallback(
    async (newModelId: string) => {
      const sessionId = activeSessionId ?? sessionIdRef.current;
      if (!sessionId) return;

      try {
        // Server pushes session_updated + compaction lifecycle events to all clients
        await switchModelApi(sessionId, newModelId);
      } catch (err) {
        console.error("Model switch failed:", err);
      }
    },
    [activeSessionId],
  );

  const approveToolCalls = useCallback(
    (messageId: string) => {
      const sessionId = activeSessionId ?? sessionIdRef.current;
      if (!sessionId) return;

      // Optimistically update local state
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, approvalStatus: "approved" as const }
            : m,
        ),
      );
      setIsStreaming(true);
      streamStateRef.current = { sessionId, aborted: false, activeStream: null };

      // Send approval first so the backend creates a fresh stream, then subscribe
      approveToolCallsApi(sessionId, messageId)
        .then(async () => {
          const cbs = subscribeStreamCallbacks(sessionId, () => false);
          const connected = await subscribeToStream(sessionId, cbs);
          if (!connected) {
            // Subscription failed (stream gone) — reload from DB as fallback
            const result = await fetchMessages(sessionId);
            setMessages((prev) => mergeMessages(prev, result.messages));
            setHasMore(result.hasMore);
            setDebugLog(reconstructDebugLog(result.messages));
          }
        })
        .catch((err) => {
          console.error("Approval failed:", err);
          fetchMessages(sessionId)
            .then((result) => {
              setMessages((prev) => mergeMessages(prev, result.messages));
              setHasMore(result.hasMore);
            })
            .catch(console.error);
        })
        .finally(() => {
          if (streamStateRef.current?.sessionId === sessionId) {
            streamStateRef.current = null;
          }
          if (sessionIdRef.current === sessionId) {
            setIsStreaming(false);
          }
        });
    },
    [activeSessionId, subscribeStreamCallbacks],
  );

  const denyToolCalls = useCallback(
    (messageId: string) => {
      const sessionId = activeSessionId ?? sessionIdRef.current;
      if (!sessionId) return;

      // Optimistically update local state
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, approvalStatus: "denied" as const }
            : m,
        ),
      );

      // Send denial to backend
      const reloadMessages = () =>
        fetchMessages(sessionId)
          .then((result) => {
            setMessages((prev) => mergeMessages(prev, result.messages));
            setHasMore(result.hasMore);
          })
          .catch(console.error);

      denyToolCallsApi(sessionId, messageId)
        .then(reloadMessages)
        .catch((err) => {
          console.error("Denial failed:", err);
          reloadMessages();
        });
    },
    [activeSessionId],
  );

  const trimToLatestPage = useCallback(() => {
    setMessages((prev) => {
      if (prev.length <= DEFAULT_PAGE_SIZE) return prev;
      return prev.slice(-DEFAULT_PAGE_SIZE);
    });
    setHasMore(true);
  }, []);

  const loadOlderMessages = useCallback(async () => {
    const sid = activeSessionId ?? sessionIdRef.current;
    if (!sid || !hasMore || isLoadingOlder) return;
    setIsLoadingOlder(true);
    try {
      const oldest = messages[0]?.timestamp;
      const result = await fetchMessages(sid, { before: oldest, limit: DEFAULT_PAGE_SIZE });
      setMessages((prev) => [...result.messages, ...prev]);
      setHasMore(result.hasMore);
      // Merge debug logs from older messages
      setDebugLog((prev) => [...reconstructDebugLog(result.messages), ...prev]);
    } catch (err) {
      console.error("Failed to load older messages:", err);
    } finally {
      setIsLoadingOlder(false);
    }
  }, [activeSessionId, hasMore, isLoadingOlder, messages]);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  const cancelStream = useCallback(() => {
    if (!streamStateRef.current) return;
    const sessionId = activeSessionId ?? sessionIdRef.current;
    if (!sessionId) return;

    // Tell backend to append interrupted message to the stream content
    // Backend will push it as a token event, then we set abort flag
    wsClient.request("messages.interrupt", { sessionId })
      .then(() => {
        if (streamStateRef.current?.sessionId === sessionId) {
          streamStateRef.current.aborted = true;
        }
        setIsStreaming(false);
      })
      .catch(console.error);
  }, [activeSessionId]);

  return {
    messages,
    debugLog,
    isStreaming,
    isCompacting,
    isLoadingSession,
    tokenUsage,
    autoApprove,
    setAutoApprove,
    sendMessage,
    clearMessages,
    approveToolCalls,
    denyToolCalls,
    compactContext,
    compactionError,
    switchModel,
    hasMore,
    isLoadingOlder,
    loadOlderMessages,
    trimToLatestPage,
    cancelStream,
  };
}
