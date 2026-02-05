export type Role = "user" | "assistant" | "tool" | "compaction";

// JSON Schema subset for tool parameters
export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  required?: string[];
}

// Per-operation parameter definition
export interface OperationDef {
  params: Record<string, JsonSchemaProperty>;
  required?: string[];
}

// Tool definition (registration-time)
export interface ToolDefinition {
  name: string;
  description: string;
  /** Each operation owns its parameter schemas.
   *  Single-operation tools (e.g. run_command) have one entry. */
  operations: Record<string, OperationDef>;
}

// Tool call / result (runtime)
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  output: string;
  isError?: boolean;
}

// Wire format — what gets sent between frontend and backend
export interface MessagePart {
  role: Role;
  content: string;
  images?: string[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

// Frontend display model
export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  images?: string[];
  model?: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  approvalStatus?: "pending" | "approved" | "denied" | "cancelled";
  llmRequest?: unknown;
  llmResponse?: unknown;
  /** Number of messages before this compaction to include verbatim in LLM context. Only set on compaction messages. */
  verbatimCount?: number;
  /** Tiktoken estimate of message text tokens (excluding images). Used for context budget calculations. */
  tokenCount?: number;
  /** LLM-reported output_tokens for assistant messages. Reflects actual billing usage. */
  rawTokenCount?: number;
  /** Backend-computed tool execution statuses, keyed by tool call ID. */
  toolStatuses?: Record<string, "pending" | "executing" | "done" | "cancelled" | "waiting">;
  /** Backend-computed display type hint for rendering. */
  displayType?: "user" | "assistant" | "tool_result" | "context_summary";
}

export interface ClassifiedError {
  message: string;
  code: "CONTEXT_LIMIT" | "RATE_LIMIT" | "AUTH_ERROR" | "PROVIDER_ERROR" | "UNKNOWN";
  recoverable: boolean;
}

// SSE events (discriminated union)
export type SSEEvent =
  | { type: "token"; data: string }
  | { type: "tool_call"; data: ToolCall }
  | { type: "tool_result"; data: ToolResult }
  | { type: "done"; data: { hasToolCalls: boolean } }
  | { type: "error"; data: ClassifiedError }
  | { type: "debug"; data: { direction: "request"; body: unknown } }
  | { type: "usage"; data: { inputTokens: number; outputTokens: number } }
  | { type: "snapshot"; data: { assistantId: string; content: string; model: string; toolCalls: ToolCall[] } }
  | { type: "auto_approved"; data: { messageId: string } }
  | { type: "compaction_started"; data: { sessionId: string } }
  | { type: "compaction"; data: ChatMessage }
  | { type: "compaction_error"; data: { sessionId: string; error: string } }
  | { type: "new_message"; data: ChatMessage }
  | { type: "settings_changed"; data: AppSettings }
  | { type: "session_created"; data: Session }
  | { type: "session_deleted"; data: { id: string } }
  | { type: "session_updated"; data: Session }
  | { type: "memory_changed"; data: Record<string, never> }
  | { type: "approval_changed"; data: { messageId: string; approvalStatus: string } }
  | { type: "tool_progress"; data: { toolCallId: string; toolName: string; progress: number; total: number; message?: string } };

// Request/Response types
export interface ChatRequest {
  messages: MessagePart[];
  sessionId: string;
  assistantId?: string;
}

export interface ToolExecuteRequest {
  toolCalls: ToolCall[];
}

export interface ToolExecuteResponse {
  results: ToolResult[];
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  nativeVision: boolean;
}

// Session types
export interface Session {
  id: string;
  title: string;
  autoApprove: boolean;
  /** Stored as "provider:modelId" (e.g. "deepseek:deepseek-chat"). */
  model: string;
  /** Stored as "provider:modelId" (e.g. "gemini:gemini-2.0-flash"). Empty string if not set. */
  visionModel: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionWithMessages extends Session {
  messages: ChatMessage[];
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

// Memory types
export interface Memory {
  id: string;
  header: string;
  body: string;
  tags: string[];
  sessionId: string | null;
  tokenCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryListItem {
  id: string;
  header: string;
  tags: string[];
  sessionId: string | null;
  tokenCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryListResponse {
  count: number;
  total: number;
  memories: MemoryListItem[];
}

export interface MemoryStats {
  totalMemories: number;
  totalTokens: number;
  storageLimit: number;
}

export interface MemoryCreateRequest {
  header: string;
  body: string;
  tags?: string[];
  sessionId?: string;
}

export interface MemoryUpdateRequest {
  header?: string;
  body?: string;
  tags?: string[];
}

// Runtime settings (configurable via Settings page, stored in DB)
export interface AppSettings {
  default_model: string;
  vision_model: string;
  vnc_coordinate_backend: string;
  showui_api_url: string;
  vnc_keepalive_timeout: string;
  memory_max_storage_tokens: string;
  memory_max_return_tokens: string;
  system_prompt: string;
  context_compaction_threshold: string;
  compaction_verbatim_budget: string;

  messages_page_size: string;
}
