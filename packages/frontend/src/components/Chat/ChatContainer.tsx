import type { ChatMessage } from "@vladbot/shared";
import type { DebugEntry } from "../../services/api.js";
import MessageList from "./MessageList.js";
import ChatInput from "./ChatInput.js";

interface ChatContainerProps {
  messages: ChatMessage[];
  debugByMessage: Record<string, DebugEntry[]>;
  isStreaming: boolean;
  isLoadingSession?: boolean;
  onSend: (message: string, images?: string[]) => void;
  onCancel: () => void;
  onApproveToolCalls: (messageId: string) => void;
  onDenyToolCalls: (messageId: string) => void;
  tokenUsage: { inputTokens: number; outputTokens: number } | null;
  contextWindow: number;
  onCompact?: () => void;
  isCompacting?: boolean;
  compactionError?: string | null;
  autoApprove?: boolean;
  onToggleAutoApprove?: () => void;
  verbatimBudget?: number;
  hasMore?: boolean;
  isLoadingOlder?: boolean;
  onLoadMore?: () => void;
  onTrimOlder?: () => void;
  toolProgress?: Record<string, { progress: number; total: number; message?: string }>;
}

export default function ChatContainer({
  messages,
  debugByMessage,
  isStreaming,
  isLoadingSession,
  onSend,
  onCancel,
  onApproveToolCalls,
  onDenyToolCalls,
  tokenUsage,
  contextWindow,
  onCompact,
  isCompacting,
  compactionError,
  autoApprove,
  onToggleAutoApprove,
  verbatimBudget,
  hasMore,
  isLoadingOlder,
  onLoadMore,
  onTrimOlder,
  toolProgress,
}: ChatContainerProps) {
  return (
    <div className="chat-container">
      <MessageList
        messages={messages}
        debugByMessage={debugByMessage}
        isStreaming={isStreaming}
        isCompacting={isCompacting}
        isLoadingSession={isLoadingSession}
        onApproveToolCalls={onApproveToolCalls}
        onDenyToolCalls={onDenyToolCalls}
        hasMore={hasMore}
        isLoadingOlder={isLoadingOlder}
        onLoadMore={onLoadMore}
        onTrimOlder={onTrimOlder}
        toolProgress={toolProgress}
      />
      <ChatInput
        onSend={onSend}
        onCancel={onCancel}
        disabled={isStreaming}
        isStreaming={isStreaming}
        autoApprove={autoApprove}
        onToggleAutoApprove={onToggleAutoApprove}
        tokenUsage={tokenUsage}
        contextWindow={contextWindow}
        onCompact={onCompact}
        isCompacting={isCompacting}
        compactionError={compactionError}
        verbatimBudget={verbatimBudget}
      />
    </div>
  );
}
