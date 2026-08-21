/**
 * Adapter: convert SWE-bench instances (JSON from fetch_swebench.py)
 * into BugCase objects that the existing engine can consume.
 *
 * Key tension
 * ----------
 * SWE-bench patches are unified diffs against real repos. Our PoC engine
 * works on a single Python function as a self-contained `buggyCode` string.
 * The fetch script gives us a *snippet* of the hunk (context + change),
 * not the full function source.
 *
 * We resolve this by telling the agents explicitly that the code they're
 * seeing is a partial snippet, and that they should reason about the
 * visible lines. This is lossy — a real production system would clone
 * the repo at base_commit and feed the full function — but it keeps the
 * PoC self-contained and is enough to evaluate whether the reasoning
 * loop generalises beyond toy bugs.
 */
import { promises as fs } from "node:fs";
import type { BugCase } from "../types/engine.js";

export interface SwebenchCase {
  id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  file_path: string;
  function_name: string;
  buggy_code_snippet: string;
  fixed_code_snippet: string;
  /** v2 only: full buggy function source (extracted via git show). */
  buggy_code_function?: string;
  /** v2 only: full fixed function source. */
  fixed_code_function?: string;
  /** v2 only: full buggy file content at base_commit. */
  buggy_code_full?: string | null;
  fail_to_pass: string[];
  pass_to_pass: string[];
  hunk_old_start: number;
  hunk_old_count: number;
  added_lines: number;
  removed_lines: number;
  /** v2 only: how the case was extracted ("full_repo_clone" | "snippet_fallback"). */
  source?: string;
}

export interface SwebenchFile {
  count: number;
  cases: SwebenchCase[];
}

export async function loadSwebenchCases(path: string): Promise<SwebenchCase[]> {
  const raw = await fs.readFile(path, "utf8");
  const parsed = JSON.parse(raw) as SwebenchFile;
  // SWE-bench stores FAIL_TO_PASS / PASS_TO_PASS as JSON-encoded strings,
  // not as arrays. Normalise them here so the rest of the engine can
  // treat them as plain arrays.
  return parsed.cases.map(normalizeCase);
}

function normalizeCase(c: SwebenchCase): SwebenchCase {
  return {
    ...c,
    fail_to_pass: parseStringList(c.fail_to_pass),
    pass_to_pass: parseStringList(c.pass_to_pass),
  };
}

function parseStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p as string[];
    } catch {
      // fall through
    }
    return [v];
  }
  return [];
}

/**
 * Convert a SwebenchCase into a BugCase. The buggy code is the snippet
 * (with a header comment hinting at the function name). The symptom is
 * derived from the problem statement + the fail-to-pass tests.
 */
export function swebenchToBugCase(c: SwebenchCase): BugCase {
  const codeWithHint =
    `# Snippet from ${c.file_path} (function: ${c.function_name})\n` +
    `# This is a partial view of the function — only the lines around the bug.\n` +
    c.buggy_code_snippet;

  const failingTests = (c.fail_to_pass || [])
    .filter((t) => t.trim().length > 0)
    .slice(0, 3)
    .map((t) => `  - ${t}`)
    .join("\n");

  const symptom =
    `Issue from ${c.repo}:\n${truncate(c.problem_statement, 800)}\n\n` +
    `Failing tests after the bug:\n${failingTests || "  (none specified)"}`;

  const specification =
    `Function \`${c.function_name}\` in \`${c.file_path}\` (repo: ${c.repo}). ` +
    `The function is part of a real-world codebase. ` +
    `Use the problem statement and the visible snippet to identify and fix the bug. ` +
    `Only change the lines implicated by the bug; preserve everything else.`;

  return {
    id: c.id,
    language: "python",
    description: `${c.repo}: ${c.function_name}() — ${c.added_lines}+/${c.removed_lines}- in ${c.file_path}`,
    buggyCode: codeWithHint,
    symptom,
    referenceFix: c.fixed_code_snippet,
    specification,
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}
