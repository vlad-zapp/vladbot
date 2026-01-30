interface ContextMeterProps {
  usage: { inputTokens: number; outputTokens: number };
  contextWindow: number;
  onCompact?: () => void;
  isCompacting?: boolean;
  disabled?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function ContextMeter({
  usage,
  contextWindow,
  onCompact,
  isCompacting,
  disabled,
}: ContextMeterProps) {
  const totalUsed = usage.inputTokens + usage.outputTokens;
  const pct = Math.min(100, Math.round((totalUsed / contextWindow) * 100));

  let color = "var(--text-muted)";
  if (pct >= 90) color = "#e05555";
  else if (pct >= 70) color = "#d4a03c";

  return (
    <div className="context-meter" title={`${formatTokens(totalUsed)} / ${formatTokens(contextWindow)} tokens`}>
      {onCompact && (
        <button
          className="compact-btn"
          onClick={onCompact}
          disabled={disabled || isCompacting}
          title="Compact context"
        >
          {isCompacting ? "\u231B" : "\uD83E\uDDF9"}
        </button>
      )}
      <div className="context-meter-bar">
        <div
          className="context-meter-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="context-meter-label" style={{ color }}>
        Context {pct}%
      </span>
    </div>
  );
}
