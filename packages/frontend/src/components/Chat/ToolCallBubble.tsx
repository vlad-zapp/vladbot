import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolCall, ToolResult } from "@vladbot/shared";

export type ToolCallStatus =
  | "pending"
  | "waiting"
  | "executing"
  | "done"
  | "cancelled";

interface ToolCallBubbleProps {
  toolCall: ToolCall;
  result?: ToolResult;
  status: ToolCallStatus;
}

interface ImageResult {
  image_base64?: string;
  image_url?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

function tryParseImageResult(output: string): ImageResult | null {
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object" && (parsed.image_base64 || parsed.image_url)) {
      return parsed as ImageResult;
    }
  } catch {
    // not JSON or no image data
  }
  return null;
}

function tryFormatMemoryResult(toolName: string, output: string): React.ReactNode | null {
  if (!toolName.startsWith("memory_")) return null;
  try {
    const data = JSON.parse(output);
    if (!data || typeof data !== "object") return null;

    // save / update / delete — status responses
    if (data.status) {
      const statusColor = data.status === "error" ? "#e05555" : "#5ec26a";
      return (
        <div className="memory-result">
          <div className="memory-result-status" style={{ color: statusColor }}>
            {data.status === "saved" && "Memory saved"}
            {data.status === "updated" && "Memory updated"}
            {data.status === "deleted" && "Memory deleted"}
            {data.status === "error" && `Error: ${data.message}`}
          </div>
          {data.header && <div className="memory-result-header">{data.header}</div>}
          {data.tags?.length > 0 && (
            <div className="memory-result-tags">
              {data.tags.map((t: string) => <span key={t} className="memory-tag">{t}</span>)}
            </div>
          )}
          {data.token_count != null && (
            <div className="memory-result-meta">{data.token_count} tokens</div>
          )}
        </div>
      );
    }

    // search / list — results with memories array
    if (Array.isArray(data.memories)) {
      return (
        <div className="memory-result">
          <div className="memory-result-meta">
            {data.count} result{data.count !== 1 ? "s" : ""}
            {data.total != null && ` of ${data.total} total`}
            {data.truncated && " (truncated)"}
          </div>
          {data.memories.map((m: Record<string, unknown>) => (
            <div key={m.id as string} className="memory-result-item">
              <div className="memory-result-header">{m.header as string}</div>
              {(m.tags as string[])?.length > 0 && (
                <div className="memory-result-tags">
                  {(m.tags as string[]).map((t) => <span key={t} className="memory-tag">{t}</span>)}
                </div>
              )}
              {m.body ? <div className="memory-result-body">{String(m.body)}</div> : null}
            </div>
          ))}
        </div>
      );
    }
  } catch {
    // fall through to raw output
  }
  return null;
}

export default function ToolCallBubble({
  toolCall,
  result,
  status,
}: ToolCallBubbleProps) {
  const imageResult = useMemo(
    () => (result && !result.isError ? tryParseImageResult(result.output) : null),
    [result],
  );

  const imageSrc = imageResult?.image_url ?? imageResult?.image_base64 ?? null;

  // Elapsed timer for executing state
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (status === "executing") {
      const start = Date.now();
      setElapsed(0);
      intervalRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - start) / 1000));
      }, 1000);
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, [status]);

  return (
    <div className={`tool-call-bubble${status === "cancelled" ? " tool-call-cancelled" : ""}`}>
      <div className="tool-call-header">{toolCall.name}</div>
      <div className="tool-call-args">
        {Object.entries(toolCall.arguments).map(([key, value]) => (
          <div key={key} className="tool-call-arg">
            <span className="tool-call-arg-key">{key}:</span>{" "}
            <span className="tool-call-arg-value">
              {typeof value === "string" ? `"${value}"` : JSON.stringify(value)}
            </span>
          </div>
        ))}
      </div>

      {status === "waiting" && (
        <div className="tool-call-status-waiting">Waiting...</div>
      )}

      {status === "executing" && (
        <div className="tool-call-executing">
          <span className="tool-call-executing-spinner" />
          Executing...{elapsed > 0 && ` (${elapsed}s)`}
        </div>
      )}

      {status === "cancelled" && (
        <div className="tool-call-status-cancelled">Cancelled</div>
      )}

      {result && (() => {
        const memoryFormatted = !result.isError ? tryFormatMemoryResult(toolCall.name, result.output) : null;
        return (
          <details className="tool-call-output" open={!!imageResult || !!memoryFormatted}>
            <summary>Output{result.isError ? " (error)" : ""}</summary>
            {imageResult && imageSrc ? (
              <a
                href={imageSrc}
                target="_blank"
                rel="noopener noreferrer"
                className="tool-call-screenshot-link"
              >
                <img
                  src={imageSrc}
                  alt={imageResult.width && imageResult.height ? `Image (${imageResult.width}x${imageResult.height})` : "Tool result image"}
                  className="tool-call-screenshot"
                />
              </a>
            ) : memoryFormatted ? (
              memoryFormatted
            ) : (
              <pre className="tool-call-output-content">{result.output}</pre>
            )}
          </details>
        );
      })()}
    </div>
  );
}
