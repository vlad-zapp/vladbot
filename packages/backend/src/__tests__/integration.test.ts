import { describe, it, expect, beforeAll } from "vitest";
import type { ToolCall, ToolDefinition } from "@vladbot/shared";

const BASE = "http://localhost:3001/api";

// These tests require the dev server running and a valid DEEPSEEK_API_KEY.
// Run with: npm test -w @vladbot/backend

async function parseSSEStream(
  res: Response,
): Promise<{
  tokens: string[];
  toolCalls: ToolCall[];
  hasToolCalls: boolean;
  error?: string;
}> {
  const tokens: string[] = [];
  const toolCalls: ToolCall[] = [];
  let hasToolCalls = false;
  let error: string | undefined;

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const json = trimmed.slice(6);
      try {
        const event = JSON.parse(json);
        if (event.type === "token") tokens.push(event.data);
        else if (event.type === "tool_call") toolCalls.push(event.data);
        else if (event.type === "done") hasToolCalls = event.data.hasToolCalls;
        else if (event.type === "error") error = event.data;
      } catch {
        // skip
      }
    }
  }

  return { tokens, toolCalls, hasToolCalls, error };
}

describe("Integration: /api/tools", () => {
  it("returns filesystem and run_command definitions", async () => {
    const res = await fetch(`${BASE}/tools`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.definitions).toBeInstanceOf(Array);
    expect(body.definitions.length).toBeGreaterThanOrEqual(2);
    const fs = body.definitions.find(
      (d: ToolDefinition) => d.name === "filesystem",
    );
    expect(fs).toBeDefined();
    expect(fs.operations.list_directory).toBeDefined();
    const rc = body.definitions.find(
      (d: ToolDefinition) => d.name === "run_command",
    );
    expect(rc).toBeDefined();
    expect(rc.operations.execute.params.command).toBeDefined();
  });
});

describe("Integration: /api/chat/tools/execute", () => {
  it("executes filesystem tool call", async () => {
    const res = await fetch(`${BASE}/chat/tools/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolCalls: [
          {
            id: "tc-1",
            name: "filesystem_list_directory",
            arguments: { path: "/tmp" },
          },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].toolCallId).toBe("tc-1");
    expect(body.results[0].output).toContain("/tmp");
    expect(body.results[0].isError).toBeFalsy();
  });

  it("executes run_command tool call", async () => {
    const res = await fetch(`${BASE}/chat/tools/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolCalls: [
          { id: "tc-cmd", name: "run_command_execute", arguments: { command: "echo hi" } },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].toolCallId).toBe("tc-cmd");
    expect(body.results[0].output).toContain("hi");
    expect(body.results[0].isError).toBeFalsy();
  });

  it("returns error for unknown tool", async () => {
    const res = await fetch(`${BASE}/chat/tools/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolCalls: [{ id: "tc-2", name: "nope", arguments: {} }],
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.results[0].isError).toBe(true);
    expect(body.results[0].output).toContain("Unknown tool");
  });
});

describe("Integration: DeepSeek tool call via /api/chat/stream", () => {
  it("triggers a filesystem tool call when asked to list files", {
    timeout: 30_000,
  }, async () => {
      const res = await fetch(`${BASE}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content:
                "Use the filesystem_list_directory tool to list the contents of /tmp. Do not explain, just call the tool.",
            },
          ],
          model: "deepseek-chat",
          provider: "deepseek",
          tools: [
            {
              name: "filesystem",
              description:
                "Perform filesystem operations.",
              operations: {
                list_directory: {
                  params: {
                    path: {
                      type: "string",
                      description: "Absolute path to the directory to list.",
                    },
                  },
                  required: ["path"],
                },
              },
            },
          ],
        }),
      });

      expect(res.ok).toBe(true);
      const { toolCalls, hasToolCalls, error } = await parseSSEStream(res);

      expect(error).toBeUndefined();
      expect(hasToolCalls).toBe(true);
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      const tc = toolCalls[0];
      expect(tc.name).toBe("filesystem_list_directory");
      expect(tc.id).toBeTruthy();
      expect(tc.arguments).toBeDefined();
      expect(tc.arguments.path).toMatch(/\/tmp/);
    },
  );
});
