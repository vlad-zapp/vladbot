import type { AppSettings } from "@vladbot/shared";
import { getCachedSettings } from "../services/settingsStore.js";
import { env } from "./env.js";

/** Map of setting keys to their env-var fallback values. */
const ENV_DEFAULTS: Record<keyof AppSettings, () => string> = {
  default_model: () => "",
  vision_model: () => env.VISION_MODEL,
  vnc_coordinate_backend: () => env.VNC_COORDINATE_BACKEND,
  showui_api_url: () => env.SHOWUI_API_URL,
  vnc_keepalive_timeout: () => String(env.VNC_CONNECTION_TIMEOUT),
  memory_max_storage_tokens: () => String(env.MEMORY_MAX_STORAGE_TOKENS),
  memory_max_return_tokens: () => String(env.MEMORY_MAX_RETURN_TOKENS),
  system_prompt: () => "",
  context_compaction_threshold: () => "90",
  compaction_verbatim_budget: () => "40",

  messages_page_size: () => "30",
};

/**
 * Get a single runtime setting. Reads from DB cache, falls back to env var.
 */
export async function getRuntimeSetting(
  key: keyof AppSettings,
): Promise<string> {
  const dbSettings = await getCachedSettings();
  if (dbSettings[key] !== undefined) {
    return dbSettings[key];
  }
  return ENV_DEFAULTS[key]();
}

/**
 * Get all settings with env defaults merged in.
 */
export async function getAllRuntimeSettings(): Promise<AppSettings> {
  const dbSettings = await getCachedSettings();
  const result = {} as Record<string, string>;
  for (const key of Object.keys(ENV_DEFAULTS) as (keyof AppSettings)[]) {
    result[key] =
      dbSettings[key] !== undefined
        ? dbSettings[key]
        : ENV_DEFAULTS[key]();
  }
  return result as unknown as AppSettings;
}
