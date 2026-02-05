import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  progress?: { progress: number; total: number; message?: string };
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

function tryFormatBrowserResult(toolName: string, output: string): React.ReactNode | null {
  if (!toolName.startsWith("browser_")) return null;
  try {
    const data = JSON.parse(output);
    if (!data || typeof data !== "object") return null;

    // browser_connect
    if (data.type === "browser_connect") {
      return (
        <div className="browser-result">
          <div className="browser-result-status browser-result-connected">Connected</div>
          {data.title && <div className="browser-result-title">{data.title}</div>}
          {data.url && (
            <a href={data.url} target="_blank" rel="noopener noreferrer" className="browser-result-url">
              {data.url}
            </a>
          )}
        </div>
      );
    }

    // browser_disconnect
    if (data.type === "browser_disconnect") {
      return (
        <div className="browser-result">
          <div className="browser-result-status">
            {data.status === "disconnected" ? "Disconnected" : "Not connected"}
          </div>
        </div>
      );
    }

    // browser_navigate
    if (data.type === "browser_navigate") {
      // Status is OK if 2xx/3xx, or if page has title (loaded via JS despite initial status)
      const statusOk = (data.status && data.status >= 200 && data.status < 400) || !!data.title;
      return (
        <div className="browser-result">
          <div className="browser-result-nav">
            <span className={`browser-result-status-code ${statusOk ? "status-ok" : "status-error"}`}>
              {data.status ?? "???"}
            </span>
            {data.title && <span className="browser-result-title">{data.title}</span>}
          </div>
          <a href={data.url} target="_blank" rel="noopener noreferrer" className="browser-result-url">
            {data.url}
          </a>
        </div>
      );
    }

    // browser_click
    if (data.type === "browser_click") {
      const imgSrc = data.image_url ?? data.image_base64;
      return (
        <div className="browser-result">
          <div className="browser-result-action">
            Clicked {data.element_role && <span className="browser-result-element">{data.element_role}</span>}
            {data.element_name && ` "${data.element_name}"`}
          </div>
          {imgSrc && (
            <a href={imgSrc} target="_blank" rel="noopener noreferrer" className="browser-result-screenshot-link">
              <img src={imgSrc} alt="Click target" className="browser-result-screenshot" />
            </a>
          )}
        </div>
      );
    }

    // browser_type
    if (data.type === "browser_type") {
      const imgSrc = data.image_url ?? data.image_base64;
      return (
        <div className="browser-result">
          <div className="browser-result-action">
            Typed {data.element_role && <>into <span className="browser-result-element">{data.element_role}</span></>}
            {data.element_name && ` "${data.element_name}"`}
          </div>
          <div className="browser-result-typed">"{data.typed}"</div>
          {imgSrc && (
            <a href={imgSrc} target="_blank" rel="noopener noreferrer" className="browser-result-screenshot-link">
              <img src={imgSrc} alt="Type target" className="browser-result-screenshot" />
            </a>
          )}
        </div>
      );
    }

    // browser_press
    if (data.type === "browser_press") {
      return (
        <div className="browser-result">
          <div className="browser-result-action">
            Pressed <span className="browser-result-key">{data.key}</span>
          </div>
        </div>
      );
    }

    // browser_scroll
    if (data.type === "browser_scroll") {
      return (
        <div className="browser-result">
          <div className="browser-result-action">
            Scrolled {data.direction} ({data.amount})
          </div>
        </div>
      );
    }

    // browser_content
    if (data.type === "browser_content") {
      // Collapsed version (old results in LLM context)
      if (data.note) {
        return (
          <div className="browser-result browser-result-collapsed">
            {data.title && <span className="browser-result-title">{data.title}</span>}
            {data.url && (
              <a href={data.url} target="_blank" rel="noopener noreferrer" className="browser-result-url">
                {data.url}
              </a>
            )}
            <div className="browser-result-note">{data.note}</div>
          </div>
        );
      }

      const startIdx = data.offset ?? 0;
      const endIdx = data.next_offset ?? data.total ?? startIdx;
      const showPagination = data.has_more || startIdx > 0;
      return (
        <div className="browser-result">
          <div className="browser-result-nav">
            <span className="browser-result-title">{data.title}</span>
          </div>
          <a href={data.url} target="_blank" rel="noopener noreferrer" className="browser-result-url">
            {data.url}
          </a>
          <div className="browser-result-meta">
            ~{data.token_estimate?.toLocaleString()} tokens
            {showPagination && data.total != null && (
              <span className="browser-result-page">
                {" "}(elements {startIdx}-{endIdx - 1} of {data.total.toLocaleString()})
              </span>
            )}
            {data.has_more && (
              <span className="browser-result-more"> - use offset={endIdx} for next page</span>
            )}
          </div>
          {data.content && (
            <pre className="browser-result-content">{data.content}</pre>
          )}
        </div>
      );
    }

    // browser_js
    if (data.type === "browser_js") {
      return (
        <div className="browser-result">
          <div className="browser-result-action">JavaScript executed</div>
          {data.result !== undefined && (
            <pre className="browser-result-content">
              {typeof data.result === "string" ? data.result : JSON.stringify(data.result, null, 2)}
            </pre>
          )}
        </div>
      );
    }

    // browser_get_text
    if (data.type === "browser_get_text" && Array.isArray(data.elements)) {
      return (
        <div className="browser-result">
          <div className="browser-result-action">Element text ({data.elements.length})</div>
          {data.elements.map((el: { index: number; text: string; role: string; error?: string }) => (
            <div key={el.index} className="browser-result-text-item">
              <span className="browser-result-element">[{el.index}] {el.role}</span>
              {el.error ? (
                <span className="browser-result-error">{el.error}</span>
              ) : (
                <pre className="browser-result-text">{el.text}</pre>
              )}
            </div>
          ))}
        </div>
      );
    }

    // browser_describe
    if (data.type === "browser_describe") {
      return (
        <div className="browser-result browser-result-describe">
          <div className="browser-result-meta">
            {data.parts_processed} part{data.parts_processed !== 1 ? "s" : ""} analyzed
            {data.total_elements != null && ` (${data.total_elements.toLocaleString()} elements)`}
          </div>
          {data.description && (
            <div className="browser-result-description">
              <Markdown remarkPlugins={[remarkGfm]}>{data.description}</Markdown>
            </div>
          )}
        </div>
      );
    }

    // browser_find_all
    if (data.type === "browser_find_all") {
      return (
        <div className="browser-result browser-result-find">
          <div className="browser-result-meta">
            Found {data.count} element{data.count !== 1 ? "s" : ""}
            {data.total != null && data.total !== data.count && ` (showing ${data.count} of ${data.total})`}
            {data.has_more && (
              <span className="browser-result-more"> — use offset={data.next_offset} for more</span>
            )}
          </div>
          {Array.isArray(data.elements) && data.elements.length > 0 && (
            <div className="browser-result-elements">
              {data.elements.slice(0, 20).map((el: { id: number; desc: string }, i: number) => (
                <div key={i} className="browser-result-element-item">
                  <span className="browser-result-element-id">[{el.id}]</span>
                  <span className="browser-result-element-desc">{el.desc}</span>
                </div>
              ))}
              {data.elements.length > 20 && (
                <div className="browser-result-truncated">
                  ... and {data.elements.length - 20} more
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

  } catch {
    // fall through
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

function tryFormatVisionResult(toolName: string, output: string): React.ReactNode | null {
  if (toolName !== "vision_analyze") return null;
  try {
    const data = JSON.parse(output);
    if (!data || typeof data !== "object") return null;

    if (data.error) {
      return (
        <div className="vision-result vision-result-error">
          {data.error}
        </div>
      );
    }

    if (data.result) {
      return (
        <div className="vision-result">
          <Markdown remarkPlugins={[remarkGfm]}>{data.result}</Markdown>
        </div>
      );
    }
  } catch {
    // fall through
  }
  return null;
}

export default function ToolCallBubble({
  toolCall,
  result,
  status,
  progress,
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
          {progress ? (
            <>
              {progress.message || `Part ${progress.progress}/${progress.total}`}
              {elapsed > 0 && ` (${elapsed}s)`}
            </>
          ) : (
            <>Executing...{elapsed > 0 && ` (${elapsed}s)`}</>
          )}
        </div>
      )}

      {status === "cancelled" && (
        <div className="tool-call-status-cancelled">Cancelled by user</div>
      )}

      {result && status !== "cancelled" && (() => {
        const memoryFormatted = !result.isError ? tryFormatMemoryResult(toolCall.name, result.output) : null;
        const browserFormatted = !result.isError && !memoryFormatted ? tryFormatBrowserResult(toolCall.name, result.output) : null;
        const visionFormatted = !result.isError && !memoryFormatted && !browserFormatted ? tryFormatVisionResult(toolCall.name, result.output) : null;
        return (
          <details className="tool-call-output">
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
            ) : browserFormatted ? (
              browserFormatted
            ) : visionFormatted ? (
              visionFormatted
            ) : (
              <pre className="tool-call-output-content">{result.output}</pre>
            )}
          </details>
        );
      })()}
    </div>
  );
}
