import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session, SSEEvent } from "@vladbot/shared";
import {
  fetchSessions,
  createSessionApi,
  deleteSessionApi,
  updateSessionTitleApi,
  updateSessionAutoApproveApi,
  fetchLastActiveSession,
  saveLastActiveSession,
} from "../services/api.js";
import { wsClient } from "../services/wsClient.js";

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchSessions(), fetchLastActiveSession()])
      .then(([data, lastActiveId]) => {
        setSessions(data);
        if (lastActiveId && data.some((s) => s.id === lastActiveId)) {
          setActiveSessionId(lastActiveId);
        } else if (data.length > 0) {
          setActiveSessionId(data[0].id);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    // Listen for session changes from other clients
    const unsubPush = wsClient.onPush("__sessions__", (event: SSEEvent) => {
      switch (event.type) {
        case "session_created":
          setSessions((prev) => {
            if (prev.some((s) => s.id === event.data.id)) return prev;
            return [event.data, ...prev];
          });
          break;
        case "session_deleted":
          setSessions((prev) => {
            const remaining = prev.filter((s) => s.id !== event.data.id);
            setActiveSessionId((current) => {
              if (current !== event.data.id) return current;
              const nextId = remaining.length > 0 ? remaining[0].id : null;
              if (nextId) saveLastActiveSession(nextId).catch(console.error);
              return nextId;
            });
            return remaining;
          });
          break;
        case "session_updated":
          setSessions((prev) =>
            prev.map((s) => (s.id === event.data.id ? event.data : s)),
          );
          break;
      }
    });

    // Re-fetch sessions on reconnect to compensate for pushes missed while
    // the WebSocket was down (e.g., session_updated with autoApprove change).
    const unsubConn = wsClient.onConnectionChange((connected) => {
      if (connected) {
        fetchSessions().then(setSessions).catch(console.error);
      }
    });

    return () => {
      unsubPush();
      unsubConn();
    };
  }, []);

  const createNewSession = useCallback(
    async (title?: string): Promise<string> => {
      const session = await createSessionApi(title);
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      saveLastActiveSession(session.id).catch(console.error);
      return session.id;
    },
    [],
  );

  const deleteSessionById = useCallback(
    async (id: string) => {
      await deleteSessionApi(id);
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== id);
        // If we deleted the active session, switch to next or null
        setActiveSessionId((current) => {
          if (current !== id) return current;
          const nextId = remaining.length > 0 ? remaining[0].id : null;
          if (nextId) saveLastActiveSession(nextId).catch(console.error);
          return nextId;
        });
        return remaining;
      });
    },
    [],
  );

  const selectSession = useCallback((id: string) => {
    setActiveSessionId(id);
    saveLastActiveSession(id).catch(console.error);
  }, []);

  const updateLocalSessionTitle = useCallback(
    (id: string, title: string) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title } : s)),
      );
      updateSessionTitleApi(id, title).catch(console.error);
    },
    [],
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const setSessionAutoApprove = useCallback(
    (id: string, value: boolean) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, autoApprove: value } : s)),
      );
      updateSessionAutoApproveApi(id, value).catch(console.error);
    },
    [],
  );

  return {
    sessions,
    activeSessionId,
    activeSession,
    loading,
    createNewSession,
    deleteSessionById,
    selectSession,
    updateLocalSessionTitle,
    setSessionAutoApprove,
  };
}
