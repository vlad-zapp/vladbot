import { describe, it, expect, beforeEach } from "vitest";
import type { Tool } from "../services/tools/ToolExecutor.js";

// We need a fresh registry for each test. The module has a module-level Map,
// so we use dynamic imports with cache-busting or test the functions directly.
// Since the registry is shared, we'll just test additive behavior.

import {
  registerTool,
  getToolDefinitions,
  validateToolCalls,
  executeToolCalls,
} from "../services/tools/ToolExecutor.js";

const makeTool = (name: string, opts?: Partial<Tool>): Tool => ({
  definition: {
    name,
    description: `Test tool: ${name}`,
    operations: {
      execute: {
        params: {
          input: { type: "string", description: "test input" },
        },
        required: ["input"],
      },
    },
  },
  execute: opts?.execute ?? (async (args) => `executed ${name}: ${JSON.stringify(args)}`),
  validate: opts?.validate,
});

describe("ToolExecutor", () => {
  const toolName = `test_tool_${Date.now()}`;
  const tool = makeTool(toolName);

  beforeEach(() => {
    registerTool(tool);
  });

  describe("registerTool / getToolDefinitions", () => {
    it("registered tool appears in definitions", () => {
      const defs = getToolDefinitions();
      const found = defs.find((d) => d.name === toolName);
      expect(found).toBeDefined();
      expect(found!.description).toContain(toolName);
    });
  });

  describe("validateToolCalls", () => {
    it("returns empty array for valid calls", () => {
      const errors = validateToolCalls([
        { id: "tc1", name: `${toolName}_execute`, arguments: { input: "hi" } },
      ]);
      expect(errors).toHaveLength(0);
    });

    it("returns error for unknown tool", () => {
      const errors = validateToolCalls([
        { id: "tc2", name: "nonexistent_tool_xyz", arguments: {} },
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0].isError).toBe(true);
      expect(errors[0].output).toContain("Unknown tool");
    });

    it("calls tool.validate when present", () => {
      const validatingName = `validating_${Date.now()}`;
      const validatingTool = makeTool(validatingName, {
        validate: (args) => {
          if (!args.input) return { valid: false, error: "input required" };
          return { valid: true };
        },
      });
      registerTool(validatingTool);

      const errorsGood = validateToolCalls([
        { id: "tc3", name: `${validatingName}_execute`, arguments: { input: "ok" } },
      ]);
      expect(errorsGood).toHaveLength(0);

      const errorsBad = validateToolCalls([
        { id: "tc4", name: `${validatingName}_execute`, arguments: {} },
      ]);
      expect(errorsBad).toHaveLength(1);
      expect(errorsBad[0].output).toContain("input required");
    });
  });

  describe("executeToolCalls", () => {
    it("executes a tool and returns output", async () => {
      const results = await executeToolCalls([
        { id: "tc5", name: `${toolName}_execute`, arguments: { input: "hello" } },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].toolCallId).toBe("tc5");
      expect(results[0].output).toContain("hello");
      expect(results[0].isError).toBeFalsy();
    });

    it("returns error for unknown tool", async () => {
      const results = await executeToolCalls([
        { id: "tc6", name: "totally_unknown_tool", arguments: {} },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].isError).toBe(true);
      expect(results[0].output).toContain("Unknown tool");
    });

    it("catches thrown errors from execute", async () => {
      const throwingName = `throwing_${Date.now()}`;
      registerTool(makeTool(throwingName, {
        execute: async () => { throw new Error("boom"); },
      }));

      const results = await executeToolCalls([
        { id: "tc7", name: `${throwingName}_execute`, arguments: {} },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].isError).toBe(true);
      expect(results[0].output).toContain("boom");
    });

    it("passes sessionId to execute", async () => {
      const sessionName = `session_${Date.now()}`;
      let receivedSessionId: string | undefined;
      registerTool(makeTool(sessionName, {
        execute: async (_args, sessionId) => {
          receivedSessionId = sessionId;
          return "ok";
        },
      }));

      await executeToolCalls(
        [{ id: "tc8", name: `${sessionName}_execute`, arguments: {} }],
        "my-session-123",
      );
      expect(receivedSessionId).toBe("my-session-123");
    });

    it("handles multiple calls sequentially", async () => {
      const results = await executeToolCalls([
        { id: "tc9a", name: `${toolName}_execute`, arguments: { input: "first" } },
        { id: "tc9b", name: `${toolName}_execute`, arguments: { input: "second" } },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].toolCallId).toBe("tc9a");
      expect(results[1].toolCallId).toBe("tc9b");
    });
  });
});
