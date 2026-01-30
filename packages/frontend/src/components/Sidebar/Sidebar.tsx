import type { Session } from "@vladbot/shared";

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onDeleteSession: (id: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onDeleteSession,
  isOpen,
  onClose,
}: SidebarProps) {
  return (
    <>
      {isOpen && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside className={`sidebar ${isOpen ? "sidebar-open" : ""}`}>
        <div className="session-list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${session.id === activeSessionId ? "session-item-active" : ""}`}
              onClick={() => {
                onSelectSession(session.id);
                onClose();
              }}
            >
              <span className="session-title">{session.title}</span>
              <button
                className="session-delete-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteSession(session.id);
                }}
                aria-label="Delete session"
              >
                &times;
              </button>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="sidebar-empty">No conversations yet</div>
          )}
        </div>
        <div className="sidebar-footer">
          <button className="new-chat-btn" onClick={onNewChat}>
            {"\uD83D\uDCAC"} New Chat
          </button>
        </div>
      </aside>
    </>
  );
}
