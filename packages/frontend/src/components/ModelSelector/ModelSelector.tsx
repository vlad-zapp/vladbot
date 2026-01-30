import type { ModelInfo } from "@vladbot/shared";

interface ModelSelectorProps {
  models: ModelInfo[];
  selectedModel: ModelInfo | null;
  onSelect: (model: ModelInfo) => void;
  disabled: boolean;
}

export default function ModelSelector({
  models,
  selectedModel,
  onSelect,
  disabled,
}: ModelSelectorProps) {
  return (
    <select
      className="model-selector"
      value={selectedModel?.id ?? ""}
      onChange={(e) => {
        const model = models.find((m) => m.id === e.target.value);
        if (model) onSelect(model);
      }}
      disabled={disabled}
      title="LLM model"
    >
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          🧠 {m.name} ({m.provider})
        </option>
      ))}
    </select>
  );
}
