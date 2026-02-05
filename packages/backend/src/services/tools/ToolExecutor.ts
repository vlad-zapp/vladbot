import type { ToolDefinition, ToolCall, ToolResult } from "@vladbot/shared";

export type ToolProgressCallback = (
  toolCallId: string,
  toolName: string,
  progress: number,
  total: number,
  message?: string,
) => void;

export interface ToolExecuteContext {
  sessionId?: string;
  toolCallId?: string;
  onProgress?: ToolProgressCallback;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, sessionId?: string, context?: ToolExecuteContext): Promise<string>;
  validate?(args: Record<string, unknown>): { valid: boolean; error?: string };
}

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  registry.set(tool.definition.name, tool);
}

export function getToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).map((t) => t.definition);
}

/**
 * Resolve a flat tool call name (e.g. "vnc_screenshot") to the registered
 * tool and the operation to inject into args.
 */
function resolveTool(
  callName: string,
): { tool: Tool; operation: string } | null {
  for (const [name, tool] of registry) {
    const prefix = `${name}_`;
    if (callName.startsWith(prefix)) {
      const opName = callName.slice(prefix.length);
      if (opName in tool.definition.operations) {
        return { tool, operation: opName };
      }
    }
  }
  return null;
}

export function validateToolCalls(calls: ToolCall[]): ToolResult[] {
  const errors: ToolResult[] = [];
  for (const call of calls) {
    const resolved = resolveTool(call.name);
    if (!resolved) {
      errors.push({
        toolCallId: call.id,
        output: `Unknown tool: ${call.name}`,
        isError: true,
      });
      continue;
    }
    const args = { ...call.arguments, operation: resolved.operation };
    if (resolved.tool.validate) {
      const result = resolved.tool.validate(args);
      if (!result.valid) {
        errors.push({
          toolCallId: call.id,
          output: result.error ?? "Validation failed",
          isError: true,
        });
      }
    }
  }
  return errors;
}

export async function executeToolCalls(
  calls: ToolCall[],
  sessionId?: string,
  onProgress?: ToolProgressCallback,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const call of calls) {
    const resolved = resolveTool(call.name);
    if (!resolved) {
      results.push({
        toolCallId: call.id,
        output: `Unknown tool: ${call.name}`,
        isError: true,
      });
      continue;
    }

    const args = { ...call.arguments, operation: resolved.operation };
    const context: ToolExecuteContext = {
      sessionId,
      toolCallId: call.id,
      onProgress,
    };
    try {
      const output = await resolved.tool.execute(args, sessionId, context);
      results.push({ toolCallId: call.id, output });
    } catch (err) {
      results.push({
        toolCallId: call.id,
        output: err instanceof Error ? err.message : "Tool execution failed",
        isError: true,
      });
    }
  }

  return results;
}
