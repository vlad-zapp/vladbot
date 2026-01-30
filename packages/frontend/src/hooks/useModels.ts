import { useEffect, useRef, useState } from "react";
import type { ModelInfo } from "@vladbot/shared";
import { fetchModels } from "../services/api.js";

export function useModels(defaultModelId?: string) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const modelsRef = useRef<ModelInfo[]>([]);

  // Fetch models once on mount
  useEffect(() => {
    fetchModels()
      .then((data) => {
        setModels(data);
        modelsRef.current = data;
        const preferred = defaultModelId
          ? data.find((m) => m.id === defaultModelId)
          : undefined;
        setSelectedModel(preferred ?? data[0] ?? null);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
    // Only run once — defaultModelId at mount time is used for initial selection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to default model changes from settings sync (other clients)
  useEffect(() => {
    if (!defaultModelId || modelsRef.current.length === 0) return;
    const match = modelsRef.current.find((m) => m.id === defaultModelId);
    if (match) {
      setSelectedModel((current) => current?.id === match.id ? current : match);
    }
  }, [defaultModelId]);

  return { models, selectedModel, setSelectedModel, loading };
}
