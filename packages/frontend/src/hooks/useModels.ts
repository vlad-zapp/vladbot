import { useEffect, useState } from "react";
import type { ModelInfo } from "@vladbot/shared";
import { fetchModels } from "../services/api.js";

export function useModels() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchModels()
      .then(setModels)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return { models, loading };
}
