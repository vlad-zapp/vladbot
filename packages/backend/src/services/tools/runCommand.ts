import { exec } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./ToolExecutor.js";

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 300_000;
const MAX_OUTPUT = 50_000;

export const runCommandTool: Tool = {
  definition: {
    name: "run_command",
    description: `Execute a shell command and return its output.

IMPORTANT: Do NOT use this tool for file or directory operations (reading, writing, creating, deleting, listing, moving, copying, permissions, etc.). Use the "filesystem" tool instead — it is purpose-built for those tasks and is safer and more reliable.

Use this tool ONLY for:
- Running programs and scripts (node, python, cargo, etc.)
- Build tools (make, npm run, cargo build)
- Version control (git commands)
- Package managers (npm, pip, cargo)
- System utilities (ps, top, df, which)
- Network tools (curl, wget, ping)
- Any other command that is NOT a file/directory operation

This tool has the lowest priority. Prefer other available tools when they can accomplish the task.`,
    operations: {
      execute: {
        params: {
          command: {
            type: "string",
            description: "The shell command to execute. Runs via /bin/sh -c.",
          },
          working_directory: {
            type: "string",
            description:
              "Working directory for the command. Defaults to the server's current working directory.",
          },
          timeout_ms: {
            type: "number",
            description:
              "Timeout in milliseconds. Default: 30000 (30s). Maximum: 300000 (5min).",
          },
        },
        required: ["command"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = args.command as string;
    if (!command) throw new Error("Missing required argument: command");

    let timeoutMs = Number(args.timeout_ms) || DEFAULT_TIMEOUT;
    timeoutMs = Math.max(1000, Math.min(MAX_TIMEOUT, timeoutMs));

    const cwd = (args.working_directory as string) || process.cwd();
    const resolved = path.resolve(cwd);

    try {
      const s = await stat(resolved);
      if (!s.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Not a directory")) throw err;
      throw new Error(`Invalid working directory: ${resolved}`);
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: resolved,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });

      return formatOutput(0, stdout, stderr);
    } catch (error: unknown) {
      const err = error as Record<string, unknown>;
      const code = err.code ?? err.status ?? "unknown";
      const stdout = (err.stdout as string) || "";
      const stderr = (err.stderr as string) || "";

      if (err.killed) {
        return `Command timed out after ${timeoutMs}ms\n${formatOutput(code, stdout, stderr)}`;
      }
      return formatOutput(code, stdout, stderr);
    }
  },
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n[truncated]";
}

function formatOutput(
  code: unknown,
  stdout: string,
  stderr: string,
): string {
  const out = truncate(stdout || "(empty)", MAX_OUTPUT);
  const err = truncate(stderr || "(empty)", MAX_OUTPUT);
  return `Exit code: ${code}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`;
}
