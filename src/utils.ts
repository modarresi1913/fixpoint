/**
 * Helpers shared across agents: file I/O, logging, ID generation.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Create a directory if it does not exist; no-op otherwise. */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Write a file, creating parent directories as needed. */
export async function writeFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
}

/** Read a file, returning null if it does not exist. */
export async function readFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Short unique id, good enough for PoC. */
export function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

/** ISO timestamp without milliseconds, for readable logs. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Pretty-print a JSON-safe value into a single line. */
export function oneLine(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}
