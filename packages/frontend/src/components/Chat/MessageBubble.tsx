import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "@vladbot/shared";
import type { DebugEntry } from "../../services/api.js";
import ToolCallBubble from "./ToolCallBubble.js";
import type { ToolCallStatus } from "./ToolCallBubble.js";
import LogsOverlay from "./LogsOverlay.js";

function fmtShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtExact(n: number): string {
  return n.toLocaleString();
}

function TokenCount({ message }: { message: ChatMessage }) {
  if (message.tokenCount == null && message.rawTokenCount == null) return null;
  const clean = message.tokenCount;
  const raw = message.rawTokenCount;
  const isUser = message.role === "user";
  const rawLabel = isUser ? "input tokens billed" : "output tokens billed";

  let label: string;
  let tip: string;
  if (clean != null && raw != null) {
    label = `${fmtShort(clean)}/${fmtShort(raw)}`;
    tip = `Estimated: ${fmtExact(clean)} tokens (tiktoken) · Actual: ${fmtExact(raw)} ${rawLabel} (LLM-reported)`;
  } else if (clean != null) {
    label = fmtShort(clean);
    tip = `Estimated: ${fmtExact(clean)} tokens (tiktoken)`;
  } else {
    label = fmtShort(raw!);
    tip = `Actual: ${fmtExact(raw!)} ${rawLabel} (LLM-reported)`;
  }
  return (
    <span className="message-token-count" title={tip}>{label}</span>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  debugEntries?: DebugEntry[];
  onApprove?: () => void;
  onDeny?: () => void;
}

function getToolStatus(
  index: number,
  message: ChatMessage,
): ToolCallStatus {
  const results = message.toolResults ?? [];
  const status = message.approvalStatus;

  // Has a result for this tool → done
  const tc = message.toolCalls![index];
  const result = results.find((r) => r.toolCallId === tc.id);
  if (result) return "done";

  // Not approved yet (and no results exist from a previous execution)
  if (status === "pending" && results.length === 0) return "pending";
  if (status === "denied") return "cancelled";

  // Approved — check if a previous tool errored
  const prevErrored = results.some((r) => r.isError);
  if (prevErrored) return "cancelled";

  // Approved, no prev error — executing or waiting
  if (index === results.length) return "executing";
  return "waiting";
}

export default function MessageBubble({
  message,
  debugEntries,
  onApprove,
  onDeny,
}: MessageBubbleProps) {
  const isUser = message.role === "user";

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  // Don't render tool-role messages directly (their results show in the assistant bubble)
  if (message.role === "tool") return null;

  // Render compaction bubble
  if (message.role === "compaction") {
    return (
      <div className="message message-compaction">
        <div className="compaction-header">Context compacted</div>
        <details className="compaction-details">
          <summary>View summary</summary>
          <div className="compaction-summary">{message.content}</div>
        </details>
        {(message.tokenCount || message.rawTokenCount) && (
          <div className="message-footer">
            <span />
            <TokenCount message={message} />
          </div>
        )}
      </div>
    );
  }

  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;
  const hasResults = message.toolResults && message.toolResults.length > 0;

  // Derive button visibility from DB-persisted approvalStatus (no local state)
  const showApproveButtons =
    hasToolCalls && message.approvalStatus === "pending" && !hasResults;

  const handleApprove = () => {
    onApprove?.();
  };

  const handleDeny = () => {
    onDeny?.();
  };

  // Clean up interval on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const hasLogs = debugEntries && debugEntries.length > 0;

  return (
    <div
      className={`message ${isUser ? "message-user" : "message-assistant"}`}
    >
      <div className="message-header">
        <span className="message-role">
          {isUser ? "You" : (message.model ?? "Assistant")}
        </span>
      </div>
      {message.content && (
        <div className="message-content">
          {isUser ? (
            message.content
          ) : (
            <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
          )}
        </div>
      )}
      {message.images && message.images.length > 0 && (
        <div className="message-images">
          {message.images.map((src, i) => (
            <a key={i} href={src} target="_blank" rel="noopener noreferrer">
              <img src={src} alt={`Attachment ${i + 1}`} className="message-image" />
            </a>
          ))}
        </div>
      )}
      {hasToolCalls && (
        <div className="tool-calls-container">
          {message.toolCalls!.map((tc, index) => {
            const result = message.toolResults?.find(
              (r) => r.toolCallId === tc.id,
            );
            const status = message.toolStatuses?.[tc.id] ?? getToolStatus(index, message);
            return (
              <ToolCallBubble
                key={tc.id}
                toolCall={tc}
                result={result}
                status={status}
              />
            );
          })}

          {showApproveButtons && (
            <div className="tool-calls-actions">
              <button className="tool-call-approve" onClick={handleApprove}>
                Approve
              </button>
              <button className="tool-call-deny" onClick={handleDeny}>
                Deny
              </button>
            </div>
          )}

        </div>
      )}
      {(hasLogs || message.tokenCount || message.rawTokenCount) && (
        <div className="message-footer">
          {hasLogs ? (
            <span className="logs-link" onClick={() => setShowLogs(true)}>
              logs
            </span>
          ) : <span />}
          <TokenCount message={message} />
        </div>
      )}
      {showLogs && hasLogs && (
        <LogsOverlay
          entries={debugEntries!}
          onClose={() => setShowLogs(false)}
        />
      )}
    </div>
  );
}
