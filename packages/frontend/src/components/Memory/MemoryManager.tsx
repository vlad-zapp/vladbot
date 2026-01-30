import { useState, useCallback } from "react";
import type { Memory } from "@vladbot/shared";
import { useMemories } from "../../hooks/useMemories.js";
import MemoryList from "./MemoryList.js";
import MemoryEditor from "./MemoryEditor.js";
import MemoryDetail from "./MemoryDetail.js";

export default function MemoryManager() {
  const {
    memories,
    total,
    stats,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    page,
    setPage,
    pageSize,
    getMemory,
    createMemory,
    updateMemory,
    deleteMemory,
  } = useMemories();

  // Editor modal state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);

  // Detail modal state
  const [detailMemory, setDetailMemory] = useState<Memory | null>(null);

  const handleNewMemory = useCallback(() => {
    setEditingMemory(null);
    setEditorOpen(true);
  }, []);

  const handleView = useCallback(
    async (id: string) => {
      try {
        const mem = await getMemory(id);
        setDetailMemory(mem);
      } catch {
        // ignore
      }
    },
    [getMemory],
  );

  const handleEdit = useCallback(
    async (id: string) => {
      try {
        const mem = await getMemory(id);
        setEditingMemory(mem);
        setEditorOpen(true);
        setDetailMemory(null);
      } catch {
        // ignore
      }
    },
    [getMemory],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm("Delete this memory?")) return;
      try {
        await deleteMemory(id);
        setDetailMemory(null);
      } catch {
        // ignore
      }
    },
    [deleteMemory],
  );

  const handleSave = useCallback(
    async (data: { header: string; body: string; tags: string[] }) => {
      if (editingMemory) {
        await updateMemory(editingMemory.id, data);
      } else {
        await createMemory(data);
      }
      setEditorOpen(false);
      setEditingMemory(null);
    },
    [editingMemory, updateMemory, createMemory],
  );

  const handleEditorClose = useCallback(() => {
    setEditorOpen(false);
    setEditingMemory(null);
  }, []);

  const handleDetailClose = useCallback(() => {
    setDetailMemory(null);
  }, []);

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="memory-manager">
      <div className="memory-toolbar">
        <div className="memory-search">
          <input
            type="text"
            placeholder="Search memories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <button className="memory-create-btn" onClick={handleNewMemory}>
          New Memory
        </button>
        {stats && (
          <div className="memory-stats">
            {stats.totalMemories} memories &middot; {stats.totalTokens} tokens
          </div>
        )}
      </div>

      <div className="memory-content">
        {loading && <div className="memory-loading">Loading...</div>}
        {error && <div className="memory-error">{error}</div>}
        {!loading && !error && memories.length === 0 && (
          <div className="memory-empty">
            {searchQuery
              ? "No memories match your search."
              : "No memories yet. Create your first memory!"}
          </div>
        )}
        {!loading && !error && memories.length > 0 && (
          <MemoryList
            memories={memories}
            onView={handleView}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        )}
      </div>

      {totalPages > 1 && (
        <div className="memory-pagination">
          <button
            className="memory-page-btn"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span className="memory-page-info">
            Page {page + 1} of {totalPages}
          </span>
          <button
            className="memory-page-btn"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}

      {editorOpen && (
        <MemoryEditor
          memory={editingMemory}
          onSave={handleSave}
          onClose={handleEditorClose}
        />
      )}

      {detailMemory && (
        <MemoryDetail
          memory={detailMemory}
          onEdit={() => handleEdit(detailMemory.id)}
          onDelete={() => handleDelete(detailMemory.id)}
          onClose={handleDetailClose}
        />
      )}
    </div>
  );
}
