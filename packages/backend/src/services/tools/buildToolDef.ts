import type {
  JsonSchemaProperty,
  ToolDefinition,
  OperationDef,
} from "@vladbot/shared";

export interface OperationSpec {
  params: string[];
  required?: string[];
}

/**
 * Build a ToolDefinition where each operation owns its full parameter schemas.
 * Param schemas are defined once in `params`, operations reference them by name.
 */
export function buildOperationToolDef(config: {
  name: string;
  description: string;
  /** All unique parameter schemas referenced by operations */
  params: Record<string, JsonSchemaProperty>;
  /** Per-operation: which params it uses and which are required */
  operations: Record<string, OperationSpec>;
  /** Params included in every operation (e.g. host/port for VNC) */
  common?: { params: string[]; required?: string[] };
}): ToolDefinition {
  const { name, description, params, operations, common } = config;

  const resolvedOps: Record<string, OperationDef> = {};

  for (const [opName, spec] of Object.entries(operations)) {
    const opParams: Record<string, JsonSchemaProperty> = {};

    // Add common params first
    if (common) {
      for (const n of common.params) {
        const schema = params[n];
        if (!schema) throw new Error(`Unknown param "${n}" in tool "${name}"`);
        opParams[n] = schema;
      }
    }

    // Add operation-specific params
    for (const n of spec.params) {
      const schema = params[n];
      if (!schema) throw new Error(`Unknown param "${n}" in tool "${name}"`);
      opParams[n] = schema;
    }

    const required = [
      ...(common?.required ?? []),
      ...(spec.required ?? []),
    ];

    resolvedOps[opName] = {
      params: opParams,
      ...(required.length > 0 && { required }),
    };
  }

  return { name, description, operations: resolvedOps };
}

/**
 * Flatten ToolDefinition[] into individual function definitions for LLM APIs.
 * Each operation becomes a separate function named {tool}_{operation},
 * e.g. vnc_screenshot, memory_save, filesystem_read_file.
 */
export interface FlattenedTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
}

export function flattenToolsForLLM(definitions: ToolDefinition[]): FlattenedTool[] {
  const result: FlattenedTool[] = [];
  for (const def of definitions) {
    for (const [opName, opDef] of Object.entries(def.operations)) {
      result.push({
        name: `${def.name}_${opName}`,
        description: def.description,
        parameters: {
          type: "object" as const,
          properties: opDef.params,
          ...(opDef.required?.length && { required: opDef.required }),
        },
      });
    }
  }
  return result;
}
