import { useCallback, useEffect, useState } from "react";
import type { AppSettings, SSEEvent } from "@vladbot/shared";
import { fetchSettings, updateSettings } from "../services/api.js";
import { wsClient } from "../services/wsClient.js";

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSettings()
      .then(setSettings)
      .catch(console.error)
      .finally(() => setLoading(false));

    // Listen for settings changes broadcast by other clients
    const unsub = wsClient.onPush("__settings__", (event: SSEEvent) => {
      if (event.type === "settings_changed") {
        setSettings(event.data);
      }
    });

    return unsub;
  }, []);

  const saveSettings = useCallback(
    async (partial: Partial<AppSettings>) => {
      const updated = await updateSettings(partial);
      setSettings(updated);
      return updated;
    },
    [],
  );

  return { settings, loading, saveSettings };
}
