import { useState } from "react";
import type { Memory } from "@vladbot/shared";

interface MemoryEditorProps {
  memory: Memory | null; // null = create mode
  onSave: (data: { header: string; body: string; tags: string[] }) => Promise<void>;
  onClose: () => void;
}

export default function MemoryEditor({
  memory,
  onSave,
  onClose,
}: MemoryEditorProps) {
  const [header, setHeader] = useState(memory?.header ?? "");
  const [body, setBody] = useState(memory?.body ?? "");
  const [tagsInput, setTagsInput] = useState(
    memory?.tags.join(", ") ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!header.trim()) {
      setError("Header is required");
      return;
    }
    if (!body.trim()) {
      setError("Body is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await onSave({ header: header.trim(), body: body.trim(), tags });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setSaving(false);
    }
  };

  return (
    <div className="memory-modal-backdrop" onClick={onClose}>
      <div className="memory-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="memory-modal-title">
          {memory ? "Edit Memory" : "New Memory"}
        </h2>
        <form onSubmit={handleSubmit}>
          <div className="memory-form-group">
            <label className="memory-form-label" htmlFor="memory-header">
              Header
            </label>
            <input
              id="memory-header"
              className="memory-form-input"
              type="text"
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              placeholder="Memory title..."
              disabled={saving}
            />
          </div>
          <div className="memory-form-group">
            <label className="memory-form-label" htmlFor="memory-body">
              Body
            </label>
            <textarea
              id="memory-body"
              className="memory-form-textarea"
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Memory content..."
              disabled={saving}
            />
          </div>
          <div className="memory-form-group">
            <label className="memory-form-label" htmlFor="memory-tags">
              Tags (comma-separated)
            </label>
            <input
              id="memory-tags"
              className="memory-form-input"
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="tag1, tag2, tag3"
              disabled={saving}
            />
          </div>
          {error && <div className="memory-form-error">{error}</div>}
          <div className="memory-form-actions">
            <button
              type="button"
              className="memory-cancel-btn"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="memory-save-btn"
              disabled={saving}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
