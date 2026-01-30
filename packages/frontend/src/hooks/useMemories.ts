import { useCallback, useEffect, useState } from "react";
import type {
  Memory,
  MemoryCreateRequest,
  MemoryListItem,
  MemoryStats,
  MemoryUpdateRequest,
  SSEEvent,
} from "@vladbot/shared";
import {
  fetchMemories,
  fetchMemory,
  fetchMemoryStats,
  createMemoryApi,
  updateMemoryApi,
  deleteMemoryApi,
} from "../services/api.js";
import { wsClient } from "../services/wsClient.js";

const PAGE_SIZE = 20;

export function useMemories() {
  const [memories, setMemories] = useState<MemoryListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [order, setOrder] = useState<"newest" | "oldest">("newest");

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listData, statsData] = await Promise.all([
        fetchMemories({
          query: debouncedQuery || undefined,
          tags: filterTags.length ? filterTags : undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          order,
        }),
        fetchMemoryStats(),
      ]);
      setMemories(listData.memories);
      setTotal(listData.total);
      setStats(statsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load memories");
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery, filterTags, page, order]);

  // Refresh on filter/page/order changes
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Listen for memory changes from other clients
  useEffect(() => {
    const unsub = wsClient.onPush("__memories__", (event: SSEEvent) => {
      if (event.type === "memory_changed") {
        refresh();
      }
    });
    return unsub;
  }, [refresh]);

  const getMemory = useCallback(async (id: string): Promise<Memory> => {
    return fetchMemory(id);
  }, []);

  const createMemory = useCallback(
    async (data: MemoryCreateRequest) => {
      await createMemoryApi(data);
      await refresh();
    },
    [refresh],
  );

  const updateMemory = useCallback(
    async (id: string, data: MemoryUpdateRequest) => {
      await updateMemoryApi(id, data);
      await refresh();
    },
    [refresh],
  );

  const deleteMemory = useCallback(
    async (id: string) => {
      await deleteMemoryApi(id);
      await refresh();
    },
    [refresh],
  );

  return {
    memories,
    total,
    stats,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    filterTags,
    setFilterTags,
    page,
    setPage,
    order,
    setOrder,
    pageSize: PAGE_SIZE,
    refresh,
    getMemory,
    createMemory,
    updateMemory,
    deleteMemory,
  };
}
