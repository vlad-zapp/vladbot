import { useEffect } from "react";
import type { DebugEntry } from "../../services/api.js";

interface LogsOverlayProps {
  entries: DebugEntry[];
  onClose: () => void;
}

const BASE64_IMG_RE = /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{100,}/g;

export default function LogsOverlay({ entries, onClose }: LogsOverlayProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="logs-overlay" onClick={handleBackdropClick}>
      <div className="logs-overlay-panel">
        <div className="logs-overlay-header">
          <span>Logs ({entries.length})</span>
          <button className="logs-overlay-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="logs-overlay-body">
          {entries.map((entry, i) => (
            <div key={i} className="debug-entry">
              <div className="debug-entry-header">
                <span className="debug-direction">
                  {entry.direction === "request"
                    ? "\u2192 Request"
                    : "\u2190 Response"}
                </span>
                <span className="debug-timestamp">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <DebugBody body={entry.body} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DebugBody({ body }: { body: unknown }) {
  const json = JSON.stringify(body, null, 2) ?? "null";
  const parts = splitWithImages(json);

  return (
    <pre className="debug-body">
      {parts.map((part, i) =>
        part.type === "text" ? (
          <span key={i}>{part.value}</span>
        ) : (
          <span key={i}>
            {"\n"}
            <img className="debug-image" src={part.value} alt="embedded" />
            {"\n"}
          </span>
        ),
      )}
    </pre>
  );
}

function splitWithImages(
  text: string,
): { type: "text" | "image"; value: string }[] {
  const result: { type: "text" | "image"; value: string }[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(BASE64_IMG_RE)) {
    const start = match.index!;
    if (start > lastIndex) {
      result.push({ type: "text", value: text.slice(lastIndex, start) });
    }
    result.push({ type: "image", value: match[0] });
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push({ type: "text", value: text.slice(lastIndex) });
  }

  return result;
}
