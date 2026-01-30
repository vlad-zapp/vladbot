import path from "node:path";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILES_BASE = path.resolve(__dirname, "../../../../data/files");

mkdirSync(FILES_BASE, { recursive: true });

/**
 * Save a buffer as a session-scoped file.
 * Returns the filename (not full path), e.g. "1706500000000-a1b2c3.jpg".
 */
export function saveSessionFile(
  sessionId: string,
  data: Buffer,
  ext: string,
): string {
  const dir = path.join(FILES_BASE, sessionId);
  mkdirSync(dir, { recursive: true });

  const short = uuid().slice(0, 8);
  const filename = `${Date.now()}-${short}.${ext}`;
  writeFileSync(path.join(dir, filename), data);
  return filename;
}

/**
 * Resolve the absolute path for a session file.
 * Returns null if it doesn't exist or the filename looks suspicious.
 */
export function getSessionFilePath(
  sessionId: string,
  filename: string,
): string | null {
  // Prevent path traversal
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return null;
  }
  const filePath = path.join(FILES_BASE, sessionId, filename);
  return existsSync(filePath) ? filePath : null;
}

/**
 * Remove all files for a session.
 */
export function deleteSessionFiles(sessionId: string): void {
  const dir = path.join(FILES_BASE, sessionId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
