import { useCallback, useEffect, useRef } from "react";
import type { ChatMessage } from "@vladbot/shared";
import type { DebugEntry } from "../../services/api.js";
import MessageBubble from "./MessageBubble.js";
import StreamingIndicator from "./StreamingIndicator.js";

interface MessageListProps {
  messages: ChatMessage[];
  debugByMessage: Record<string, DebugEntry[]>;
  isStreaming: boolean;
  isCompacting?: boolean;
  isLoadingSession?: boolean;
  onApproveToolCalls: (messageId: string) => void;
  onDenyToolCalls: (messageId: string) => void;
  hasMore?: boolean;
  isLoadingOlder?: boolean;
  onLoadMore?: () => void;
  onTrimOlder?: () => void;
  toolProgress?: Record<string, { progress: number; total: number; message?: string }>;
}

export default function MessageList({
  messages,
  debugByMessage,
  isStreaming,
  isCompacting,
  isLoadingSession,
  onApproveToolCalls,
  onDenyToolCalls,
  hasMore,
  isLoadingOlder,
  onLoadMore,
  onTrimOlder,
  toolProgress,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  // "Stick to bottom" auto-scroll. Engaged by default, disengages when
  // user scrolls away from bottom, re-engages when user scrolls back.
  const stickyRef = useRef(true);
  // Track scroll height before prepend for position preservation
  const prevScrollHeightRef = useRef(0);
  const prependingRef = useRef(false);
  const prevMessageCountRef = useRef(0);
  // Track previous scrollTop so handleScroll can detect scroll direction
  const prevScrollTopRef = useRef(0);

  // Guard: while a programmatic smooth scroll is in flight, use a relaxed
  // threshold so intermediate scroll events don't disengage sticky.
  const autoScrollingRef = useRef(false);
  const autoScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Scroll to bottom with adaptive behavior: smooth for large jumps (new
  // messages, tool-call expansion), instant for small increments (streaming
  // tokens) so the viewport always sticks to the latest content.
  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance > 50) {
      autoScrollingRef.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      if (autoScrollTimerRef.current) clearTimeout(autoScrollTimerRef.current);
      autoScrollTimerRef.current = setTimeout(() => {
        autoScrollingRef.current = false;
      }, 400);
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // Debounce timer for trimming older messages when user returns to bottom
  const trimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- User-input listeners: immediately disengage sticky on upward scroll
  // so a single wheel click or touch swipe is enough to break away from
  // autoscroll during streaming. ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stickyRef.current = false;
    };

    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      // Finger moves down → content scrolls up
      if (e.touches[0].clientY - touchStartY > 10) {
        stickyRef.current = false;
      }
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  // Check if there's any active tool progress (tools being executed)
  const hasActiveToolProgress = toolProgress && Object.keys(toolProgress).length > 0;

  // Update sticky state on scroll events. Only RE-ENGAGES sticky when the
  // user actively scrolls down to the bottom; disengagement is handled by
  // the wheel/touch listeners above for immediate responsiveness.
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const scrollTop = el.scrollTop;
    const scrollingDown = scrollTop >= prevScrollTopRef.current;
    prevScrollTopRef.current = scrollTop;

    const threshold = autoScrollingRef.current ? 500 : 100;
    const atBottom =
      el.scrollHeight - scrollTop - el.clientHeight < threshold;
    const wasSticky = stickyRef.current;

    if (atBottom && scrollingDown) {
      // Scrolling down (or programmatic) and near the bottom → re-engage
      stickyRef.current = true;
    } else if (!atBottom && !autoScrollingRef.current && !isStreaming && !hasActiveToolProgress) {
      // Far from bottom and not in a programmatic animation and not streaming
      // and no tool progress → disengage. During streaming/tool execution, only
      // wheel/touch listeners can disengage to avoid false disengagement when
      // content expands (tool bubbles).
      stickyRef.current = false;
    }

    // When user scrolls back to the bottom, schedule a trim of older messages
    // so the DOM doesn't stay bloated. Debounce to avoid trimming during
    // a quick scroll-through.
    if (!wasSticky && stickyRef.current && onTrimOlder) {
      if (trimTimerRef.current) clearTimeout(trimTimerRef.current);
      trimTimerRef.current = setTimeout(() => {
        trimTimerRef.current = null;
        onTrimOlder();
      }, 300);
    }
    if (wasSticky && !stickyRef.current && trimTimerRef.current) {
      clearTimeout(trimTimerRef.current);
      trimTimerRef.current = null;
    }
  }, [onTrimOlder, isStreaming, hasActiveToolProgress]);

  // Auto-scroll when messages change (new tokens, new messages).
  // Only scroll if sticky is engaged - don't force scroll when user has
  // scrolled away to read older messages.
  useEffect(() => {
    if (stickyRef.current) {
      // On initial load (first batch of messages), use instant scroll to
      // avoid racing with browser scroll restoration.
      if (prevMessageCountRef.current === 0 && messages.length > 0) {
        const el = containerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      } else {
        scrollToBottom();
      }
    }
  }, [messages, scrollToBottom]);

  // Auto-scroll when tool progress updates (separate effect to avoid
  // interference with message count tracking)
  useEffect(() => {
    if (stickyRef.current && toolProgress && Object.keys(toolProgress).length > 0) {
      scrollToBottom();
    }
  }, [toolProgress, scrollToBottom]);

  // ResizeObserver on the content container catches height changes that happen
  // AFTER the React render (tool-call bubble expansion, CSS transitions, lazy
  // content, etc.) and re-scrolls to the bottom while sticky.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      if (stickyRef.current) {
        scrollToBottom();
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  // Preserve scroll position when older messages are prepended
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (prependingRef.current && messages.length > prevMessageCountRef.current) {
      const delta = el.scrollHeight - prevScrollHeightRef.current;
      el.scrollTop += delta;
      prependingRef.current = false;
    }
    prevMessageCountRef.current = messages.length;
  }, [messages]);

  // IntersectionObserver for scroll-to-top detection
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const container = containerRef.current;
    if (!sentinel || !container || !onLoadMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingOlder) {
          // Record scroll height before loading more
          prevScrollHeightRef.current = container.scrollHeight;
          prependingRef.current = true;
          onLoadMore();
        }
      },
      { root: container, threshold: 0.1 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoadingOlder, onLoadMore]);

  return (
    <div
      className="message-list"
      ref={containerRef}
      onScroll={handleScroll}
    >
      <div className="message-list-content" ref={contentRef}>
        {/* Top sentinel for infinite scroll */}
        <div ref={topSentinelRef} style={{ height: 1 }} />

        {isLoadingOlder && (
          <div className="loading-older">Loading older messages...</div>
        )}

        {!hasMore && messages.length > 0 && (
          <div className="beginning-of-conversation">Beginning of conversation</div>
        )}

        {messages.length === 0 && !isLoadingSession && (
          <div className="empty-state">Send a message to start chatting.</div>
        )}
        {messages.length === 0 && isLoadingSession && (
          <div className="empty-state">Loading...</div>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            debugEntries={debugByMessage[msg.id]}
            onApprove={() => onApproveToolCalls(msg.id)}
            onDeny={() => onDenyToolCalls(msg.id)}
            toolProgress={toolProgress}
          />
        ))}
        {isCompacting && (
          <div className="message message-compaction compacting-indicator">
            <span className="compacting-spinner" />
            Compacting context...
          </div>
        )}
        {isStreaming && <StreamingIndicator />}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
