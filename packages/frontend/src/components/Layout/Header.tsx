import type { ModelInfo } from "@vladbot/shared";
import ModelSelector from "../ModelSelector/ModelSelector.js";

export type View = "chat" | "memories" | "tools" | "settings";

interface HeaderProps {
  models: ModelInfo[];
  selectedModel: ModelInfo | null;
  onSelectModel: (model: ModelInfo) => void;
  disabled: boolean;
  onToggleSidebar: () => void;
  currentView: View;
  onChangeView: (view: View) => void;
  visionModel?: string;
  onVisionModelChange?: (value: string) => void;
  visionOverrideWarning?: boolean;
}

const NAV_ITEMS: { view: View; label: string }[] = [
  { view: "chat", label: "Chat" },
  { view: "memories", label: "Memories" },
  { view: "tools", label: "Tools" },
  { view: "settings", label: "Settings" },
];

const ALL_VISION_OPTIONS = [
  { value: "", label: "👁 No vision", provider: "" },
  { value: "gemini:gemini-2.5-pro", label: "👁 Gemini 2.5 Pro", provider: "gemini" },
  { value: "gemini:gemini-2.5-flash", label: "👁 Gemini 2.5 Flash", provider: "gemini" },
  { value: "gemini:gemini-2.0-flash", label: "👁 Gemini 2.0 Flash", provider: "gemini" },
  { value: "anthropic:claude-sonnet-4-20250514", label: "👁 Claude Sonnet 4", provider: "anthropic" },
  { value: "anthropic:claude-3-5-haiku-20241022", label: "👁 Claude 3.5 Haiku", provider: "anthropic" },
];

export default function Header({
  models,
  selectedModel,
  onSelectModel,
  disabled,
  onToggleSidebar,
  currentView,
  onChangeView,
  visionModel,
  onVisionModelChange,
  visionOverrideWarning,
}: HeaderProps) {
  const availableProviders = new Set(models.map((m) => m.provider));
  const visionOptions = ALL_VISION_OPTIONS.filter(
    (o) => o.provider === "" || availableProviders.has(o.provider),
  );

  return (
    <header className="app-header">
      <div className="header-left">
        <button
          className={`hamburger-btn${currentView !== "chat" ? " hamburger-btn-hidden" : ""}`}
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
        >
          &#9776;
        </button>
        <h1 className="app-title">Vladbot</h1>
      </div>
      <nav className="header-nav">
        {NAV_ITEMS.map(({ view, label }) => (
          <button
            key={view}
            className={`header-nav-btn${currentView === view ? " header-nav-btn-active" : ""}`}
            onClick={() => onChangeView(view)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className={`header-controls${currentView !== "chat" ? " header-controls-hidden" : ""}`}>
        <div className="model-selector-wrap">
          <ModelSelector
            models={models}
            selectedModel={selectedModel}
            onSelect={onSelectModel}
            disabled={disabled}
          />
        </div>
        {onVisionModelChange && (
          <div className="vision-selector-wrap">
            <select
              className={`vision-selector${visionOverrideWarning ? " vision-selector-warn" : ""}`}
              value={visionModel ?? ""}
              onChange={(e) => onVisionModelChange(e.target.value)}
              title="Vision model"
            >
              {visionOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value === "" && selectedModel?.nativeVision
                    ? "👁 Built-in vision"
                    : o.label}
                </option>
              ))}
            </select>
            {visionOverrideWarning && (
              <span className="vision-override-notice">
                Model has built-in vision and may use it directly
              </span>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
