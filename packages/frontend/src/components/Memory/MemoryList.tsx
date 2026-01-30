import type { MemoryListItem } from "@vladbot/shared";

interface MemoryListProps {
  memories: MemoryListItem[];
  onView: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function MemoryList({
  memories,
  onView,
  onEdit,
  onDelete,
}: MemoryListProps) {
  return (
    <div className="memory-list">
      {memories.map((mem) => (
        <div
          key={mem.id}
          className="memory-card"
          onClick={() => onView(mem.id)}
        >
          <div className="memory-card-header">
            <span className="memory-card-title">{mem.header}</span>
            <div className="memory-card-actions">
              <button
                className="memory-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(mem.id);
                }}
                aria-label="Edit memory"
              >
                Edit
              </button>
              <button
                className="memory-action-btn memory-delete-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(mem.id);
                }}
                aria-label="Delete memory"
              >
                Delete
              </button>
            </div>
          </div>
          {mem.tags.length > 0 && (
            <div className="memory-card-tags">
              {mem.tags.map((tag) => (
                <span key={tag} className="memory-tag">
                  {tag}
                </span>
              ))}
            </div>
          )}
          <div className="memory-card-meta">
            <span>{formatDate(mem.createdAt)}</span>
            <span>{mem.tokenCount} tokens</span>
          </div>
        </div>
      ))}
    </div>
  );
}
