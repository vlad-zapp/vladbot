import type { Memory } from "@vladbot/shared";

interface MemoryDetailProps {
  memory: Memory;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MemoryDetail({
  memory,
  onEdit,
  onDelete,
  onClose,
}: MemoryDetailProps) {
  return (
    <div className="memory-modal-backdrop" onClick={onClose}>
      <div className="memory-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="memory-modal-title">{memory.header}</h2>

        {memory.tags.length > 0 && (
          <div className="memory-detail-tags">
            {memory.tags.map((tag) => (
              <span key={tag} className="memory-tag">
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="memory-detail-body">{memory.body}</div>

        <div className="memory-detail-meta">
          <span>Created: {formatDate(memory.createdAt)}</span>
          <span>Updated: {formatDate(memory.updatedAt)}</span>
          <span>{memory.tokenCount} tokens</span>
          {memory.sessionId && <span>Session: {memory.sessionId}</span>}
        </div>

        <div className="memory-detail-actions">
          <button className="memory-cancel-btn" onClick={onClose}>
            Close
          </button>
          <button className="memory-save-btn" onClick={onEdit}>
            Edit
          </button>
          <button className="memory-delete-btn" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
