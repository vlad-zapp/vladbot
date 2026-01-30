import { describe, it, expect, beforeAll } from "vitest";
import { filesystemTool } from "../services/tools/filesystem.js";
import {
  registerTool,
  getToolDefinitions,
  executeToolCalls,
} from "../services/tools/ToolExecutor.js";
import path from "node:path";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  stat,
  symlink,
  readlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";

const exec = (args: Record<string, unknown>) => filesystemTool.execute(args);

describe("filesystemTool", () => {
  it("has a valid definition", () => {
    const def = filesystemTool.definition;
    expect(def.name).toBe("filesystem");
    expect(def.description).toBeTruthy();
    expect(def.operations).toBeDefined();
    expect(def.operations.list_directory).toBeDefined();
    expect(def.operations.read_file).toBeDefined();
    expect(def.operations.write_file).toBeDefined();
  });

  describe("list_directory", () => {
    it("lists files and directories", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      try {
        await writeFile(path.join(tmp, "hello.txt"), "world");
        await mkdir(path.join(tmp, "subdir"));

        const output = await exec({ operation: "list_directory", path: tmp });
        expect(output).toContain("hello.txt");
        expect(output).toContain("subdir");
        expect(output).toMatch(/file\t.*\thello\.txt/);
        expect(output).toMatch(/dir\t-\tsubdir/);
      } finally {
        await rm(tmp, { recursive: true });
      }
    });

    it("reports empty directory", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-empty-"));
      try {
        const output = await exec({ operation: "list_directory", path: tmp });
        expect(output).toContain("empty");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });

    it("shows hidden files by default", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      try {
        await writeFile(path.join(tmp, ".hidden"), "secret");
        await writeFile(path.join(tmp, "visible.txt"), "hello");

        const output = await exec({ operation: "list_directory", path: tmp });
        expect(output).toContain(".hidden");
        expect(output).toContain("visible.txt");

        const outputFiltered = await exec({
          operation: "list_directory",
          path: tmp,
          show_hidden: false,
        });
        expect(outputFiltered).not.toContain(".hidden");
        expect(outputFiltered).toContain("visible.txt");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });

    it("throws on non-existent path", async () => {
      await expect(
        exec({ operation: "list_directory", path: "/tmp/vladbot-nonexistent-xyz" }),
      ).rejects.toThrow();
    });
  });

  describe("read_file", () => {
    it("reads file contents", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      const file = path.join(tmp, "test.txt");
      try {
        await writeFile(file, "line1\nline2\nline3\n");
        const output = await exec({ operation: "read_file", path: file });
        expect(output).toContain("line1");
        expect(output).toContain("line2");
        expect(output).toContain("line3");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });

    it("supports offset and limit", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      const file = path.join(tmp, "test.txt");
      try {
        await writeFile(file, "a\nb\nc\nd\ne\n");
        const output = await exec({
          operation: "read_file",
          path: file,
          offset: 2,
          limit: 2,
        });
        expect(output).toContain("lines 2-3");
        expect(output).toContain("b");
        expect(output).toContain("c");
        expect(output).not.toContain("\na\n");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });
  });

  describe("write_file", () => {
    it("creates and writes a file", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      const file = path.join(tmp, "out.txt");
      try {
        const output = await exec({
          operation: "write_file",
          path: file,
          content: "hello world",
        });
        expect(output).toContain("Written");
        const contents = await readFile(file, "utf-8");
        expect(contents).toBe("hello world");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });
  });

  describe("append_file", () => {
    it("appends to a file", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      const file = path.join(tmp, "out.txt");
      try {
        await writeFile(file, "first");
        await exec({ operation: "append_file", path: file, content: " second" });
        const contents = await readFile(file, "utf-8");
        expect(contents).toBe("first second");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });
  });

  describe("delete", () => {
    it("deletes a file", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      const file = path.join(tmp, "del.txt");
      try {
        await writeFile(file, "bye");
        await exec({ operation: "delete", path: file });
        await expect(stat(file)).rejects.toThrow();
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it("deletes a directory recursively", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      const sub = path.join(tmp, "sub");
      try {
        await mkdir(sub);
        await writeFile(path.join(sub, "f.txt"), "x");
        await exec({ operation: "delete", path: sub, recursive: true });
        await expect(stat(sub)).rejects.toThrow();
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("mkdir", () => {
    it("creates nested directories", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      const nested = path.join(tmp, "a", "b", "c");
      try {
        await exec({ operation: "mkdir", path: nested });
        const s = await stat(nested);
        expect(s.isDirectory()).toBe(true);
      } finally {
        await rm(tmp, { recursive: true });
      }
    });
  });

  describe("copy", () => {
    it("copies a file", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      const src = path.join(tmp, "src.txt");
      const dst = path.join(tmp, "dst.txt");
      try {
        await writeFile(src, "copy me");
        await exec({ operation: "copy", source: src, destination: dst });
        const contents = await readFile(dst, "utf-8");
        expect(contents).toBe("copy me");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });
  });

  describe("move", () => {
    it("moves a file", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      const src = path.join(tmp, "src.txt");
      const dst = path.join(tmp, "dst.txt");
      try {
        await writeFile(src, "move me");
        await exec({ operation: "move", source: src, destination: dst });
        await expect(stat(src)).rejects.toThrow();
        const contents = await readFile(dst, "utf-8");
        expect(contents).toBe("move me");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });
  });

  describe("stat", () => {
    it("returns file info", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      const file = path.join(tmp, "info.txt");
      try {
        await writeFile(file, "data");
        const output = await exec({ operation: "stat", path: file });
        expect(output).toContain("Type: file");
        expect(output).toContain("Size:");
        expect(output).toContain("Permissions:");
        expect(output).toContain("Inode:");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });
  });

  describe("chmod", () => {
    it("changes permissions", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      const file = path.join(tmp, "perm.txt");
      try {
        await writeFile(file, "x");
        await exec({ operation: "chmod", path: file, mode: "755" });
        const s = await stat(file);
        expect((s.mode & 0o777).toString(8)).toBe("755");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });
  });

  describe("symlink / read_link", () => {
    it("creates and reads a symlink", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      const target = path.join(tmp, "target.txt");
      const lnk = path.join(tmp, "link.txt");
      try {
        await writeFile(target, "linked");
        await exec({ operation: "symlink", target, link_path: lnk });

        const linkTarget = await readlink(lnk);
        expect(linkTarget).toBe(target);

        const output = await exec({ operation: "read_link", path: lnk });
        expect(output).toContain(target);
      } finally {
        await rm(tmp, { recursive: true });
      }
    });
  });

  describe("search", () => {
    it("finds files matching a glob pattern", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      try {
        await writeFile(path.join(tmp, "a.ts"), "");
        await writeFile(path.join(tmp, "b.js"), "");
        await mkdir(path.join(tmp, "sub"));
        await writeFile(path.join(tmp, "sub", "c.ts"), "");

        const output = await exec({
          operation: "search",
          pattern: "**/*.ts",
          base_path: tmp,
        });
        expect(output).toContain("a.ts");
        expect(output).toContain("c.ts");
        expect(output).not.toContain("b.js");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });
  });

  describe("list_directory recursive", () => {
    it("produces a tree listing when recursive=true", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      try {
        await mkdir(path.join(tmp, "dir1"));
        await writeFile(path.join(tmp, "dir1", "f.txt"), "");
        await writeFile(path.join(tmp, "root.txt"), "");

        const output = await exec({ operation: "list_directory", path: tmp, recursive: true, max_depth: 2 });
        expect(output).toContain("dir1/");
        expect(output).toContain("f.txt");
        expect(output).toContain("root.txt");
        expect(output).toContain("├── ");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });

    it("defaults to max_depth 10", async () => {
      // Build a 12-level deep directory structure
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      try {
        let dir = tmp;
        for (let i = 1; i <= 12; i++) {
          dir = path.join(dir, `d${i}`);
          await mkdir(dir);
        }
        await writeFile(path.join(dir, "deep.txt"), "");

        const output = await exec({ operation: "list_directory", path: tmp, recursive: true });
        // Depth 10 means we see d1..d10 but not d11/d12/deep.txt
        expect(output).toContain("d10/");
        expect(output).not.toContain("d11");
        expect(output).not.toContain("deep.txt");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });

    it("respects max_depth parameter", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      try {
        await mkdir(path.join(tmp, "a", "b", "c"), { recursive: true });
        await writeFile(path.join(tmp, "a", "b", "c", "file.txt"), "");

        const shallow = await exec({ operation: "list_directory", path: tmp, recursive: true, max_depth: 1 });
        expect(shallow).toContain("a/");
        expect(shallow).not.toContain("── b/");

        const deeper = await exec({ operation: "list_directory", path: tmp, recursive: true, max_depth: 3 });
        expect(deeper).toContain("── a/");
        expect(deeper).toContain("── b/");
        expect(deeper).toContain("── c/");
        expect(deeper).not.toContain("file.txt");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });

    it("shows symlinks to files with arrow notation", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      try {
        await writeFile(path.join(tmp, "target.txt"), "hello");
        await symlink(path.join(tmp, "target.txt"), path.join(tmp, "link.txt"));

        const output = await exec({ operation: "list_directory", path: tmp, recursive: true, max_depth: 1 });
        expect(output).toContain("link.txt ->");
        expect(output).toContain("target.txt");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });

    it("shows symlinks to directories with arrow notation", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      try {
        await mkdir(path.join(tmp, "realdir"));
        await writeFile(path.join(tmp, "realdir", "inside.txt"), "");
        await symlink(path.join(tmp, "realdir"), path.join(tmp, "linkdir"));

        const output = await exec({ operation: "list_directory", path: tmp, recursive: true, max_depth: 2 });
        expect(output).toContain("linkdir/ ->");
        // Should recurse into the linked directory
        expect(output).toContain("inside.txt");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });

    it("detects symlink cycles to ancestor directories", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      try {
        await mkdir(path.join(tmp, "child"));
        // Create symlink from child/loop -> tmp (ancestor)
        await symlink(tmp, path.join(tmp, "child", "loop"));

        const output = await exec({ operation: "list_directory", path: tmp, recursive: true, max_depth: 5 });
        expect(output).toContain("loop/");
        expect(output).toContain("[cycle]");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });

    it("detects self-referencing symlinks", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      try {
        await mkdir(path.join(tmp, "dir"));
        // Symlink that points to its own parent
        await symlink(path.join(tmp, "dir"), path.join(tmp, "dir", "self"));

        const output = await exec({ operation: "list_directory", path: tmp, recursive: true, max_depth: 5 });
        expect(output).toContain("self/");
        expect(output).toContain("[cycle]");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });

    it("handles broken symlinks gracefully", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      try {
        await symlink("/nonexistent/path", path.join(tmp, "broken"));

        const output = await exec({ operation: "list_directory", path: tmp, recursive: true, max_depth: 1 });
        expect(output).toContain("broken");
        expect(output).toContain("[broken]");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });

    it("respects show_hidden=false in recursive mode", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "vladbot-test-"));
      try {
        await mkdir(path.join(tmp, ".hidden_dir"));
        await writeFile(path.join(tmp, ".hidden_dir", "secret.txt"), "");
        await writeFile(path.join(tmp, "visible.txt"), "");

        const hidden = await exec({ operation: "list_directory", path: tmp, recursive: true, max_depth: 2 });
        expect(hidden).toContain(".hidden_dir/");
        expect(hidden).toContain("secret.txt");

        const noHidden = await exec({ operation: "list_directory", path: tmp, recursive: true, max_depth: 2, show_hidden: false });
        expect(noHidden).not.toContain(".hidden_dir");
        expect(noHidden).not.toContain("secret.txt");
        expect(noHidden).toContain("visible.txt");
      } finally {
        await rm(tmp, { recursive: true });
      }
    });
  });

  describe("error handling", () => {
    it("throws on unknown operation", async () => {
      await expect(exec({ operation: "bogus" })).rejects.toThrow("Unknown operation");
    });

    it("throws on missing required args", async () => {
      await expect(exec({ operation: "read_file" })).rejects.toThrow("Missing required argument");
      await expect(exec({ operation: "write_file", path: "/tmp/x" })).rejects.toThrow(
        "Missing required argument",
      );
    });
  });
});

describe("ToolExecutor registry (filesystem)", () => {
  beforeAll(() => {
    registerTool(filesystemTool);
  });

  it("returns registered tool definitions", () => {
    const defs = getToolDefinitions();
    expect(defs.find((d) => d.name === "filesystem")).toBeDefined();
  });

  it("executes a filesystem tool call via registry", async () => {
    const results = await executeToolCalls([
      {
        id: "test-fs-1",
        name: "filesystem_list_directory",
        arguments: { path: "/tmp" },
      },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("test-fs-1");
    expect(results[0].isError).toBeFalsy();
    expect(results[0].output).toContain("/tmp");
  });
});
