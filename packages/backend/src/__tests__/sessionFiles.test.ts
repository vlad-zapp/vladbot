import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  saveSessionFile,
  getSessionFilePath,
  deleteSessionFiles,
} from "../services/sessionFiles.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILES_BASE = path.resolve(__dirname, "../../../../data/files");

// Use a unique session id per test run to avoid collisions
const testSessionId = `test-session-${Date.now()}`;

afterEach(() => {
  // Clean up test files
  const dir = path.join(FILES_BASE, testSessionId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("saveSessionFile", () => {
  it("creates file in correct directory and returns filename", () => {
    const data = Buffer.from("test content");
    const filename = saveSessionFile(testSessionId, data, "txt");

    expect(typeof filename).toBe("string");
    expect(filename).toMatch(/\.txt$/);

    const fullPath = path.join(FILES_BASE, testSessionId, filename);
    expect(existsSync(fullPath)).toBe(true);

    const contents = readFileSync(fullPath);
    expect(contents.toString()).toBe("test content");
  });

  it("generates unique filenames", () => {
    const data = Buffer.from("test");
    const f1 = saveSessionFile(testSessionId, data, "jpg");
    const f2 = saveSessionFile(testSessionId, data, "jpg");
    expect(f1).not.toBe(f2);
  });
});

describe("getSessionFilePath", () => {
  it("returns path for existing file", () => {
    const data = Buffer.from("exists");
    const filename = saveSessionFile(testSessionId, data, "txt");
    const result = getSessionFilePath(testSessionId, filename);
    expect(result).not.toBeNull();
    expect(result).toContain(testSessionId);
    expect(result).toContain(filename);
  });

  it("returns null for non-existent file", () => {
    const result = getSessionFilePath(testSessionId, "nonexistent.txt");
    expect(result).toBeNull();
  });

  it("blocks path traversal with ..", () => {
    expect(getSessionFilePath(testSessionId, "../../../etc/passwd")).toBeNull();
  });

  it("blocks path traversal with /", () => {
    expect(getSessionFilePath(testSessionId, "/etc/passwd")).toBeNull();
  });

  it("blocks path traversal with backslash", () => {
    expect(getSessionFilePath(testSessionId, "..\\..\\etc\\passwd")).toBeNull();
  });
});

describe("deleteSessionFiles", () => {
  it("removes session directory", () => {
    saveSessionFile(testSessionId, Buffer.from("delete me"), "txt");
    const dir = path.join(FILES_BASE, testSessionId);
    expect(existsSync(dir)).toBe(true);

    deleteSessionFiles(testSessionId);
    expect(existsSync(dir)).toBe(false);
  });

  it("does not throw for non-existent session", () => {
    expect(() => deleteSessionFiles("nonexistent-session-xyz")).not.toThrow();
  });
});
