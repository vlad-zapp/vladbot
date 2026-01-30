import {
  readdir,
  stat,
  lstat,
  readFile,
  writeFile,
  appendFile,
  rm,
  mkdir,
  cp,
  rename,
  chmod,
  symlink,
  link,
  readlink,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import type { Tool } from "./ToolExecutor.js";
import { buildOperationToolDef } from "./buildToolDef.js";
import type { JsonSchemaProperty } from "@vladbot/shared";

// ---------------------------------------------------------------------------
// Parameter schemas (each defined once, referenced by operations)
// ---------------------------------------------------------------------------

const P = {
  path:        { type: "string", description: "Primary path argument." },
  content:     { type: "string", description: "File content." },
  source:      { type: "string", description: "Source path." },
  destination: { type: "string", description: "Destination path." },
  target:      { type: "string", description: "Target path for link." },
  link_path:   { type: "string", description: "Link path." },
  mode:        { type: "string", description: "Permission mode (e.g. '755', '644')." },
  pattern:     { type: "string", description: "Glob pattern." },
  base_path:   { type: "string", description: "Base directory for search." },
  recursive:   { type: "boolean", description: "Operate recursively." },
  show_hidden: { type: "boolean", description: "Show hidden files." },
  max_depth:   { type: "number", description: "Maximum depth for recursive listing (default 10)." },
  offset:      { type: "number", description: "Line offset (1-based)." },
  limit:       { type: "number", description: "Max lines to read." },
} satisfies Record<string, JsonSchemaProperty>;

export const filesystemTool: Tool = {
  definition: buildOperationToolDef({
    name: "filesystem",
    description: `Perform filesystem operations. This is the PREFERRED tool for ALL file and directory manipulation. Always use this tool instead of run_command for any file or directory operations.

Supported operations:
- list_directory: List directory contents with types and sizes. Use recursive=true for a tree view.
- read_file: Read file contents
- write_file: Create or overwrite a file
- append_file: Append content to a file
- delete: Delete a file or directory
- mkdir: Create a directory
- copy: Copy file or directory
- move: Move or rename file or directory
- stat: Get detailed file/directory info
- chmod: Change permissions
- symlink: Create symbolic link
- hardlink: Create hard link
- read_link: Read symlink target
- search: Glob-based file search`,
    params: P,
    operations: {
      list_directory: { params: ["path", "recursive", "max_depth", "show_hidden"], required: ["path"] },
      read_file:      { params: ["path", "offset", "limit"], required: ["path"] },
      write_file:     { params: ["path", "content"], required: ["path", "content"] },
      append_file:    { params: ["path", "content"], required: ["path", "content"] },
      delete:         { params: ["path", "recursive"], required: ["path"] },
      mkdir:          { params: ["path", "recursive"], required: ["path"] },
      copy:           { params: ["source", "destination", "recursive"], required: ["source", "destination"] },
      move:           { params: ["source", "destination"], required: ["source", "destination"] },
      stat:           { params: ["path"], required: ["path"] },
      chmod:          { params: ["path", "mode"], required: ["path", "mode"] },
      symlink:        { params: ["target", "link_path"], required: ["target", "link_path"] },
      hardlink:       { params: ["target", "link_path"], required: ["target", "link_path"] },
      read_link:      { params: ["path"], required: ["path"] },
      search:         { params: ["pattern", "base_path"], required: ["pattern"] },
    },
  }),

  async execute(args: Record<string, unknown>): Promise<string> {
    const op = args.operation as string;
    switch (op) {
      case "list_directory":
        return listDirectory(args);
      case "read_file":
        return readFileOp(args);
      case "write_file":
        return writeFileOp(args);
      case "append_file":
        return appendFileOp(args);
      case "delete":
        return deleteOp(args);
      case "mkdir":
        return mkdirOp(args);
      case "copy":
        return copyOp(args);
      case "move":
        return moveOp(args);
      case "stat":
        return statOp(args);
      case "chmod":
        return chmodOp(args);
      case "symlink":
        return symlinkOp(args);
      case "hardlink":
        return hardlinkOp(args);
      case "read_link":
        return readLinkOp(args);
      case "search":
        return searchOp(args);
      default:
        throw new Error(`Unknown operation: ${op}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireArg(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (val === undefined || val === null || val === "") {
    throw new Error(`Missing required argument: ${key}`);
  }
  return String(val);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function formatPermissions(mode: number): string {
  return "0" + (mode & 0o777).toString(8);
}

function formatDate(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function listDirectory(args: Record<string, unknown>): Promise<string> {
  const dirPath = requireArg(args, "path");
  const showHidden = args.show_hidden !== false; // default true
  const recursive = args.recursive === true;
  const resolved = path.resolve(dirPath);

  if (recursive) {
    const maxDepth = typeof args.max_depth === "number" ? args.max_depth : 10;
    const lines: string[] = [resolved];
    const visited = new Set<string>();
    const realRoot = await realpath(resolved);
    visited.add(realRoot);
    await buildTree(resolved, "", maxDepth, 0, lines, showHidden, visited);
    return lines.join("\n");
  }

  const entries = await readdir(resolved, { withFileTypes: true });
  const lines: string[] = [];

  for (const entry of entries) {
    if (!showHidden && entry.name.startsWith(".")) continue;
    const fullPath = path.join(resolved, entry.name);
    try {
      const stats = await stat(fullPath);
      const type = entry.isDirectory() ? "dir" : "file";
      const size = entry.isDirectory() ? "-" : formatSize(stats.size);
      lines.push(`${type}\t${size}\t${entry.name}`);
    } catch {
      lines.push(`?\t-\t${entry.name}`);
    }
  }

  if (lines.length === 0) {
    return `Directory is empty: ${resolved}`;
  }
  return `Contents of ${resolved}:\n${lines.join("\n")}`;
}

async function readFileOp(args: Record<string, unknown>): Promise<string> {
  const filePath = path.resolve(requireArg(args, "path"));
  const raw = await readFile(filePath, "utf-8");

  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;

  if (offset === undefined && limit === undefined) {
    return `Contents of ${filePath}:\n${raw}`;
  }

  const lines = raw.split("\n");
  const start = Math.max(0, (offset ?? 1) - 1);
  const sliced = limit !== undefined ? lines.slice(start, start + limit) : lines.slice(start);
  const end = start + sliced.length;

  return `Contents of ${filePath} (lines ${start + 1}-${end}):\n${sliced.join("\n")}`;
}

async function writeFileOp(args: Record<string, unknown>): Promise<string> {
  const filePath = path.resolve(requireArg(args, "path"));
  const content = requireArg(args, "content");
  await writeFile(filePath, content, "utf-8");
  return `Written ${Buffer.byteLength(content, "utf-8")} bytes to ${filePath}`;
}

async function appendFileOp(args: Record<string, unknown>): Promise<string> {
  const filePath = path.resolve(requireArg(args, "path"));
  const content = requireArg(args, "content");
  await appendFile(filePath, content, "utf-8");
  return `Appended ${Buffer.byteLength(content, "utf-8")} bytes to ${filePath}`;
}

async function deleteOp(args: Record<string, unknown>): Promise<string> {
  const target = path.resolve(requireArg(args, "path"));
  const recursive = args.recursive === true;
  await rm(target, { recursive, force: false });
  return `Deleted ${target}`;
}

async function mkdirOp(args: Record<string, unknown>): Promise<string> {
  const dirPath = path.resolve(requireArg(args, "path"));
  const recursive = args.recursive !== false; // default true
  await mkdir(dirPath, { recursive });
  return `Created directory ${dirPath}`;
}

async function copyOp(args: Record<string, unknown>): Promise<string> {
  const source = path.resolve(requireArg(args, "source"));
  const destination = path.resolve(requireArg(args, "destination"));
  const recursive = args.recursive === true;
  await cp(source, destination, { recursive });
  return `Copied ${source} to ${destination}`;
}

async function moveOp(args: Record<string, unknown>): Promise<string> {
  const source = path.resolve(requireArg(args, "source"));
  const destination = path.resolve(requireArg(args, "destination"));
  await rename(source, destination);
  return `Moved ${source} to ${destination}`;
}

async function statOp(args: Record<string, unknown>): Promise<string> {
  const target = path.resolve(requireArg(args, "path"));
  const stats = await stat(target);
  const lstats = await lstat(target);

  const isSymlink = lstats.isSymbolicLink();
  const type = isSymlink
    ? "symlink"
    : stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : "other";

  const lines = [
    `Path: ${target}`,
    `Type: ${type}`,
    `Size: ${formatSize(stats.size)} (${stats.size} bytes)`,
    `Permissions: ${formatPermissions(stats.mode)}`,
    `Owner: uid=${stats.uid} gid=${stats.gid}`,
    `Created: ${formatDate(stats.birthtime)}`,
    `Modified: ${formatDate(stats.mtime)}`,
    `Accessed: ${formatDate(stats.atime)}`,
    `Inode: ${stats.ino}`,
    `Hard links: ${stats.nlink}`,
  ];

  if (isSymlink) {
    const linkTarget = await readlink(target);
    lines.push(`Link target: ${linkTarget}`);
  }

  return lines.join("\n");
}

async function chmodOp(args: Record<string, unknown>): Promise<string> {
  const target = path.resolve(requireArg(args, "path"));
  const mode = requireArg(args, "mode");
  await chmod(target, parseInt(mode, 8));
  return `Changed permissions of ${target} to ${mode}`;
}

async function symlinkOp(args: Record<string, unknown>): Promise<string> {
  const target = requireArg(args, "target");
  const linkPath = path.resolve(requireArg(args, "link_path"));
  await symlink(target, linkPath);
  return `Created symlink ${linkPath} -> ${target}`;
}

async function hardlinkOp(args: Record<string, unknown>): Promise<string> {
  const target = path.resolve(requireArg(args, "target"));
  const linkPath = path.resolve(requireArg(args, "link_path"));
  await link(target, linkPath);
  return `Created hardlink ${linkPath} -> ${target}`;
}

async function readLinkOp(args: Record<string, unknown>): Promise<string> {
  const target = path.resolve(requireArg(args, "path"));
  const linkTarget = await readlink(target);
  return `${target} -> ${linkTarget}`;
}

async function searchOp(args: Record<string, unknown>): Promise<string> {
  const pattern = requireArg(args, "pattern");
  const basePath = args.base_path ? path.resolve(String(args.base_path)) : process.cwd();

  const matches = await glob(pattern, { cwd: basePath, absolute: true });

  if (matches.length === 0) {
    return `No matches found for pattern "${pattern}" in ${basePath}`;
  }
  return `Found ${matches.length} match(es) in ${basePath}:\n${matches.join("\n")}`;
}

async function buildTree(
  dirPath: string,
  prefix: string,
  maxDepth: number,
  currentDepth: number,
  lines: string[],
  showHidden: boolean = true,
  visited: Set<string> = new Set(),
): Promise<void> {
  if (currentDepth >= maxDepth) return;

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  if (!showHidden) {
    entries = entries.filter((e) => !e.name.startsWith("."));
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    const childPath = path.join(dirPath, entry.name);

    // Check if this is a symlink pointing to a directory
    if (entry.isSymbolicLink()) {
      try {
        const linkTarget = await readlink(childPath);
        const resolvedTarget = await realpath(childPath);
        const targetStat = await stat(resolvedTarget);
        if (targetStat.isDirectory()) {
          if (visited.has(resolvedTarget)) {
            lines.push(`${prefix}${connector}${entry.name}/ -> ${linkTarget} [cycle]`);
            continue;
          }
          lines.push(`${prefix}${connector}${entry.name}/ -> ${linkTarget}`);
          visited.add(resolvedTarget);
          await buildTree(resolvedTarget, prefix + childPrefix, maxDepth, currentDepth + 1, lines, showHidden, visited);
          continue;
        }
        // Symlink to file
        lines.push(`${prefix}${connector}${entry.name} -> ${linkTarget}`);
        continue;
      } catch {
        // Broken symlink
        lines.push(`${prefix}${connector}${entry.name} -> [broken]`);
        continue;
      }
    }

    const type = entry.isDirectory() ? "/" : "";
    lines.push(`${prefix}${connector}${entry.name}${type}`);

    if (entry.isDirectory()) {
      await buildTree(childPath, prefix + childPrefix, maxDepth, currentDepth + 1, lines, showHidden, visited);
    }
  }
}
