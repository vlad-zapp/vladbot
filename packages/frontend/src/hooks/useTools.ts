import { useEffect, useState } from "react";
import type { ToolDefinition } from "@vladbot/shared";
import { fetchTools } from "../services/api.js";

export function useTools() {
  const [toolDefinitions, setToolDefinitions] = useState<ToolDefinition[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTools()
      .then((data) => {
        setToolDefinitions(data.definitions);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return { toolDefinitions, loading };
}
