import { z } from "zod";

export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.unknown()),
});

export const toolResultSchema = z.object({
  toolCallId: z.string(),
  output: z.string(),
  isError: z.boolean().optional(),
});

export const jsonSchemaPropertySchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    type: z.enum(["string", "number", "boolean", "object", "array"]),
    description: z.string().optional(),
    enum: z.array(z.string()).optional(),
    properties: z.record(jsonSchemaPropertySchema).optional(),
    items: jsonSchemaPropertySchema.optional(),
    required: z.array(z.string()).optional(),
  }),
);

export const operationDefSchema = z.object({
  params: z.record(jsonSchemaPropertySchema),
  required: z.array(z.string()).optional(),
});

export const toolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  operations: z.record(operationDefSchema),
});

export const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "tool", "compaction"]),
        content: z.string(),
        images: z.array(z.string()).optional(),
        toolCalls: z.array(toolCallSchema).optional(),
        toolResults: z.array(toolResultSchema).optional(),
      }),
    )
    .default([]),
  model: z.string().min(1),
  provider: z.string().min(1),
  tools: z.array(toolDefinitionSchema).optional(),
  sessionId: z.string().optional(),
  assistantId: z.string().optional(),
});

export const toolExecuteSchema = z.object({
  toolCalls: z.array(toolCallSchema).min(1),
  sessionId: z.string().optional(),
});
