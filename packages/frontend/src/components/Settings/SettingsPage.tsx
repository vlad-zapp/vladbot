import { useEffect, useState } from "react";
import type { AppSettings, ModelInfo } from "@vladbot/shared";
import { wsClient } from "../../services/wsClient.js";
import "../../styles/settings.css";

interface SettingsPageProps {
  settings: AppSettings | null;
  models: ModelInfo[];
  onSave: (partial: Partial<AppSettings>) => Promise<AppSettings>;
}

const VISION_OPTIONS = [
  { value: "", label: "Disabled" },
  { value: "gemini:gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "gemini:gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "gemini:gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { value: "anthropic:claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
  { value: "anthropic:claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
];

export default function SettingsPage({ settings, models, onSave }: SettingsPageProps) {
  const [form, setForm] = useState<Partial<AppSettings>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [retryCount, setRetryCount] = useState(() => wsClient.getRetryCount());

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const handleRetryChange = (value: number) => {
    const clamped = Math.max(0, Math.min(10, Math.round(value)));
    setRetryCount(clamped);
    wsClient.setRetryCount(clamped);
  };

  // Settings managed programmatically elsewhere (auto-approve toggle, session tracking).
  // Exclude from the Settings page save to avoid overwriting with stale values.
  const EXCLUDED_KEYS: (keyof AppSettings)[] = ["auto_approve", "last_active_session_id"];

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const filtered = Object.fromEntries(
        Object.entries(form).filter(([k]) => !EXCLUDED_KEYS.includes(k as keyof AppSettings)),
      ) as Partial<AppSettings>;
      await onSave(filtered);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  };

  const update = (key: keyof AppSettings, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  if (!settings) {
    return <div className="settings-page"><div className="settings-content"><p>Loading settings...</p></div></div>;
  }

  return (
    <div className="settings-page">
      <div className="settings-content">
      <h2 className="settings-title">Settings</h2>

      <section className="settings-section">
        <h3 className="settings-section-title">Model Defaults</h3>
        <label className="settings-field">
          <span className="settings-label">Default LLM Model</span>
          <select
            className="settings-select"
            value={form.default_model ?? ""}
            onChange={(e) => update("default_model", e.target.value)}
          >
            <option value="">First available</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.provider})
              </option>
            ))}
          </select>
          <span className="settings-hint">Model selected by default when opening the app</span>
        </label>

        <label className="settings-field">
          <span className="settings-label">Vision Model</span>
          <select
            className="settings-select"
            value={form.vision_model ?? ""}
            onChange={(e) => update("vision_model", e.target.value)}
          >
            {VISION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <span className="settings-hint">
            Vision model used for image analysis. When set, all providers use this instead of native vision.
          </span>
        </label>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">VNC & Coordinates</h3>
        <label className="settings-field">
          <span className="settings-label">Coordinate Detection Backend</span>
          <div className="settings-radio-group">
            <label className="settings-radio">
              <input
                type="radio"
                name="vnc_coordinate_backend"
                value="vision"
                checked={form.vnc_coordinate_backend === "vision"}
                onChange={(e) => update("vnc_coordinate_backend", e.target.value)}
              />
              Vision Model
            </label>
            <label className="settings-radio">
              <input
                type="radio"
                name="vnc_coordinate_backend"
                value="showui"
                checked={form.vnc_coordinate_backend === "showui"}
                onChange={(e) => update("vnc_coordinate_backend", e.target.value)}
              />
              ShowUI
            </label>
          </div>
        </label>

        {form.vnc_coordinate_backend === "showui" && (
          <label className="settings-field">
            <span className="settings-label">ShowUI API URL</span>
            <input
              type="text"
              className="settings-input"
              value={form.showui_api_url ?? ""}
              onChange={(e) => update("showui_api_url", e.target.value)}
              placeholder="http://localhost:7860"
            />
          </label>
        )}

        <label className="settings-field">
          <span className="settings-label">VNC Session Keep-Alive (seconds)</span>
          <input
            type="number"
            className="settings-input settings-input-short"
            value={form.vnc_keepalive_timeout ?? "300"}
            onChange={(e) => update("vnc_keepalive_timeout", e.target.value)}
            min={0}
          />
          <span className="settings-hint">Idle VNC sessions are disconnected after this period. 0 = keep alive forever.</span>
        </label>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">Memory</h3>
        <label className="settings-field">
          <span className="settings-label">Max Storage Tokens per Record</span>
          <input
            type="number"
            className="settings-input settings-input-short"
            value={form.memory_max_storage_tokens ?? "200000"}
            onChange={(e) => update("memory_max_storage_tokens", e.target.value)}
            min={0}
          />
          <span className="settings-hint">Maximum token size for a single memory record</span>
        </label>
        <label className="settings-field">
          <span className="settings-label">Max Return Tokens per Query</span>
          <input
            type="number"
            className="settings-input settings-input-short"
            value={form.memory_max_return_tokens ?? "200000"}
            onChange={(e) => update("memory_max_return_tokens", e.target.value)}
            min={0}
          />
          <span className="settings-hint">Maximum tokens returned in a single memory query</span>
        </label>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">Context & Display</h3>
        <label className="settings-field">
          <span className="settings-label">Auto-Compact Threshold (%)</span>
          <input
            type="number"
            className="settings-input settings-input-short"
            value={form.context_compaction_threshold ?? "90"}
            onChange={(e) => update("context_compaction_threshold", e.target.value)}
            min={50}
            max={100}
          />
          <span className="settings-hint">
            When context usage exceeds this percentage, older messages are automatically summarized to free space.
          </span>
        </label>
        <label className="settings-field">
          <span className="settings-label">Verbatim Tail Budget (%)</span>
          <input
            type="number"
            className="settings-input settings-input-short"
            value={form.compaction_verbatim_budget ?? "40"}
            onChange={(e) => update("compaction_verbatim_budget", e.target.value)}
            min={0}
            max={50}
          />
          <span className="settings-hint">
            Percentage of the context window reserved for keeping recent messages verbatim during compaction. 0% = summarize everything, 50% = keep as many recent messages as possible.
          </span>
        </label>
        <label className="settings-field">
          <span className="settings-label">Messages Per Page</span>
          <input
            type="number"
            className="settings-input settings-input-short"
            value={form.messages_page_size ?? "30"}
            onChange={(e) => update("messages_page_size", e.target.value)}
            min={5}
            max={200}
          />
          <span className="settings-hint">
            Number of messages loaded at a time. Scroll to the top to load older messages.
          </span>
        </label>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">Connection</h3>
        <label className="settings-field">
          <span className="settings-label">WebSocket Retry Count</span>
          <input
            type="number"
            className="settings-input settings-input-short"
            value={retryCount}
            onChange={(e) => handleRetryChange(Number(e.target.value))}
            min={0}
            max={10}
          />
          <span className="settings-hint">
            Number of server-side retries for failed requests (0-10). Higher values improve reliability on unstable networks.
          </span>
        </label>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">System Prompt</h3>
        <label className="settings-field">
          <span className="settings-label">Custom System Prompt</span>
          <textarea
            className="settings-textarea"
            value={form.system_prompt ?? ""}
            onChange={(e) => update("system_prompt", e.target.value)}
            rows={6}
            placeholder="Leave empty to use the default system prompt"
          />
          <span className="settings-hint">
            Sent to all LLMs as the system message. Leave empty for the built-in default.
          </span>
        </label>
      </section>

      <div className="settings-actions">
        <button
          className="settings-save-btn"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
        {saved && <span className="settings-saved">Saved</span>}
      </div>
      </div>
    </div>
  );
}
