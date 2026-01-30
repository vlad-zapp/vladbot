import { describe, it, expect } from "vitest";
import { runCommandTool } from "../services/tools/runCommand.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = (args: Record<string, unknown>) => runCommandTool.execute(args);

describe("runCommandTool", () => {
  it("has a valid definition", () => {
    const def = runCommandTool.definition;
    expect(def.name).toBe("run_command");
    expect(def.description).toBeTruthy();
    expect(def.description).toContain("filesystem");
    expect(def.operations.execute).toBeDefined();
    expect(def.operations.execute.required).toContain("command");
  });

  it("runs a simple command", async () => {
    const output = await exec({ command: "echo hello" });
    expect(output).toContain("Exit code: 0");
    expect(output).toContain("hello");
  });

  it("captures stderr", async () => {
    const output = await exec({ command: "echo err >&2" });
    expect(output).toContain("Exit code: 0");
    expect(output).toContain("err");
  });

  it("reports non-zero exit code", async () => {
    const output = await exec({ command: "exit 42" });
    expect(output).toContain("Exit code: 42");
  });

  it("uses working_directory", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-cmd-"));
    try {
      const output = await exec({ command: "pwd", working_directory: tmp });
      expect(output).toContain(tmp);
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it("rejects invalid working directory", async () => {
    await expect(
      exec({ command: "echo x", working_directory: "/tmp/vladbot-nonexistent-xyz" }),
    ).rejects.toThrow("Invalid working directory");
  });

  it("times out long-running commands", async () => {
    const output = await exec({ command: "sleep 10", timeout_ms: 1000 });
    expect(output).toContain("timed out");
  }, 10_000);

  it("throws on missing command", async () => {
    await expect(exec({})).rejects.toThrow("Missing required argument: command");
  });
});
