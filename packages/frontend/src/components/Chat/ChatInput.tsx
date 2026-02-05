import { useRef, useState, useEffect, memo, type FormEvent, type KeyboardEvent, type ClipboardEvent } from "react";

interface PendingImage {
  name: string;
  dataUri: string;
}

interface ChatInputProps {
  onSend: (message: string, images?: string[]) => void;
  onCancel: () => void;
  disabled: boolean;
  isStreaming: boolean;
  autoApprove?: boolean;
  onToggleAutoApprove?: () => void;
  tokenUsage: { inputTokens: number; outputTokens: number } | null;
  contextWindow: number;
  onCompact?: () => void;
  isCompacting?: boolean;
  compactionError?: string | null;
  verbatimBudget?: number;
}

function ChatInput({ onSend, onCancel, disabled, isStreaming, autoApprove, onToggleAutoApprove, tokenUsage, contextWindow, onCompact, isCompacting, compactionError, verbatimBudget }: ChatInputProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const doSend = () => {
    const trimmed = input.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    onSend(trimmed, images.length > 0 ? images.map((i) => i.dataUri) : undefined);
    setInput("");
    setImages([]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    doSend();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  const addFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        setImages((prev) => [...prev, { name: file.name, dataUri: reader.result as string }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleFileChange = () => {
    if (fileInputRef.current?.files) {
      addFiles(fileInputRef.current.files);
      fileInputRef.current.value = "";
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      addFiles(imageFiles);
    }
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  // Restore focus when textarea becomes enabled after streaming
  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  // Auto-resize textarea as content changes
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // Reset height to measure true content height
    textarea.style.height = "auto";
    const maxHeight = 200;
    const newHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${newHeight}px`;
    // Only show scrollbar when content exceeds max height
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input]);

  return (
    <form className="chat-input-form" onSubmit={handleSubmit}>
      {images.length > 0 && (
        <div className="chat-input-previews">
          {images.map((img, i) => (
            <div key={i} className="chat-input-preview">
              <img src={img.dataUri} alt={img.name} />
              <button
                type="button"
                className="chat-input-preview-remove"
                onClick={() => removeImage(i)}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="chat-input-row">
          <button
            type="button"
            className="chat-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            title="Attach image"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={handleFileChange}
          />
          <textarea
            ref={textareaRef}
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Type a message..."
            disabled={disabled}
            rows={1}
          />
          {isStreaming ? (
            <button
              className="chat-cancel-btn"
              type="button"
              onClick={onCancel}
            >
              Cancel
            </button>
          ) : (
            <button
              className="chat-send-btn"
              type="button"
              onClick={doSend}
              disabled={disabled || (!input.trim() && images.length === 0)}
            >
              Send
            </button>
          )}
        <div className="chat-input-right">
          {onToggleAutoApprove && (
            <button
              type="button"
              className={`chat-action-btn${autoApprove ? " chat-autoapprove-on" : ""}`}
              onClick={onToggleAutoApprove}
              title={autoApprove ? "Auto-approve ON — click to disable" : "Auto-approve OFF — click to enable"}
            >
              {"\u26A1"}
            </button>
          )}
          {(() => {
            const totalUsed = tokenUsage ? tokenUsage.inputTokens + tokenUsage.outputTokens : 0;
            const pct = contextWindow > 0 ? Math.min(100, Math.round((totalUsed / contextWindow) * 100)) : 0;
            const minPct = verbatimBudget ?? 40;
            const tooLow = pct <= minPct;
            let color = "var(--text-muted)";
            if (compactionError) color = "#e05555";
            else if (pct >= 90) color = "#e05555";
            else if (pct >= 70) color = "#d4a03c";
            const title = compactionError
              ? `Compaction failed: ${compactionError}`
              : tooLow
                ? `Context ${pct}% — verbatim tail budget is ${minPct}%, nothing to compact`
                : `Context ${pct}% \u2014 click to compact`;
            return (
              <button
                type="button"
                className="chat-action-btn chat-compact-btn"
                onClick={onCompact}
                disabled={disabled || isCompacting || !onCompact || tooLow}
                title={title}
                style={{ color }}
              >
                {isCompacting ? "\u231B" : `\uD83E\uDDF9${pct}%`}
              </button>
            );
          })()}
        </div>
      </div>
    </form>
  );
}

export default memo(ChatInput, (prev, next) => {
  // Custom comparison to avoid re-renders when tokenUsage changes
  return (
    prev.disabled === next.disabled &&
    prev.isStreaming === next.isStreaming &&
    prev.autoApprove === next.autoApprove &&
    prev.onToggleAutoApprove === next.onToggleAutoApprove &&
    prev.onSend === next.onSend &&
    prev.onCancel === next.onCancel &&
    prev.contextWindow === next.contextWindow &&
    prev.onCompact === next.onCompact &&
    prev.isCompacting === next.isCompacting &&
    prev.compactionError === next.compactionError &&
    prev.verbatimBudget === next.verbatimBudget &&
    prev.tokenUsage?.inputTokens === next.tokenUsage?.inputTokens &&
    prev.tokenUsage?.outputTokens === next.tokenUsage?.outputTokens
  );
});
