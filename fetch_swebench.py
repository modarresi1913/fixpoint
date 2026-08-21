"""
Fetch a small, carefully-filtered subset of SWE-bench_Verified and convert
each instance into a "function-level BugCase" that our existing engine
can consume.

Strategy
--------
SWE-bench instances are full-repo PRs. Our PoC engine works on a single
Python function. So we filter aggressively:

1. Only keep instances whose `patch` touches exactly ONE file.
2. Only keep instances whose `patch` has exactly ONE hunk.
3. The hunk must be inside a single Python function (we detect this by
   parsing the buggy file with the `ast` module and finding the smallest
   enclosing function).
4. The hunk must add/remove <= 20 lines (no giant rewrites).

For each surviving instance we emit:

  {
    "id": "swebench_<instance_id>",
    "repo": "...",
    "base_commit": "...",
    "problem_statement": "...",       # the GitHub issue text
    "file_path": "...",               # the file the patch touches
    "function_name": "...",           # the enclosing function
    "buggy_code": "...",              # the function source BEFORE the patch
    "fixed_code": "...",              # the function source AFTER the patch
    "fail_to_pass": [...],            # the tests that should flip
    "pass_to_pass": [...]             # the tests that should keep passing
  }

We save the result as JSON. The TS adapter then turns each entry into a
BugCase (with the function-level code as `buggyCode` and a synthetic
symptom derived from `problem_statement` + `fail_to_pass`).

Usage:
    python3 fetch_swebench.py --n 50 --out datasets/swebench_cases.json
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
from dataclasses import dataclass, asdict
from typing import Optional

# Silence HF warnings.
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_DATASETS_OFFLINE", "0")


# ---------------------------------------------------------------------------
# Patch parsing
# ---------------------------------------------------------------------------

@dataclass
class Hunk:
    """A single unified-diff hunk."""
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    lines: list[str]  # raw lines including the leading +/-/space


HUNK_HEADER_RE = re.compile(
    r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$"
)


def parse_unified_diff(diff: str) -> list[tuple[str, list[Hunk]]]:
    """
    Parse a unified diff into [(file_path, [hunk, ...]), ...].
    Only handles plain unified diffs (the format SWE-bench uses).
    """
    files: list[tuple[str, list[Hunk]]] = []
    current_file: Optional[str] = None
    current_hunks: list[Hunk] = []
    current_hunk: Optional[Hunk] = None
    in_hunk = False

    for line in diff.splitlines(keepends=False):
        if line.startswith("diff --git"):
            # save previous file
            if current_file is not None:
                files.append((current_file, current_hunks))
            current_file = None
            current_hunks = []
            current_hunk = None
            in_hunk = False
            continue
        if line.startswith("--- "):
            # `--- a/path.py` → we will pick the path from the +++ line
            continue
        if line.startswith("+++ "):
            path = line[4:].strip()
            # strip b/ prefix
            if path.startswith("b/"):
                path = path[2:]
            current_file = path
            continue
        m = HUNK_HEADER_RE.match(line)
        if m:
            if current_hunk is not None:
                current_hunks.append(current_hunk)
            current_hunk = Hunk(
                old_start=int(m.group(1)),
                old_count=int(m.group(2) or "1"),
                new_start=int(m.group(3)),
                new_count=int(m.group(4) or "1"),
                lines=[],
            )
            in_hunk = True
            continue
        if in_hunk and current_hunk is not None:
            if line.startswith("+") or line.startswith("-") or line.startswith(" "):
                current_hunk.lines.append(line)
            else:
                # End of hunk (blank context or end of file).
                current_hunks.append(current_hunk)
                current_hunk = None
                in_hunk = False

    # flush
    if current_hunk is not None:
        current_hunks.append(current_hunk)
    if current_file is not None:
        files.append((current_file, current_hunks))

    return files


# ---------------------------------------------------------------------------
# Applying hunks (forward and reverse) to a file's source lines
# ---------------------------------------------------------------------------

def apply_hunks_to_lines(lines: list[str], hunks: list[Hunk], reverse: bool) -> list[str]:
    """
    Apply hunks to a list of source lines. `reverse=True` produces the
    pre-patch version; `reverse=False` produces the post-patch version.

    Assumes `lines` is the post-patch version if reverse=True, and the
    pre-patch version if reverse=False.

    We work bottom-up so that line numbers stay valid as we edit.
    """
    # Sort hunks by start line descending so earlier edits don't shift
    # later line numbers.
    sorted_hunks = sorted(
        hunks,
        key=lambda h: (h.old_start if not reverse else h.new_start),
        reverse=True,
    )

    out = list(lines)
    for h in sorted_hunks:
        if reverse:
            # `out` is the NEW file. We want to reconstruct the OLD file.
            # new_start is the line in the new file where the hunk starts.
            start = h.new_start - 1  # 0-indexed
            # Walk the hunk lines: '+' lines were ADDED (so remove them),
            # '-' lines were REMOVED (so re-add them), ' ' lines are context.
            new_block: list[str] = []
            for ln in h.lines:
                if ln.startswith("+"):
                    continue  # skip added lines
                content = ln[1:] if ln[:1] in "+- " else ln
                new_block.append(content)
            # Replace the range [start, start + new_count) with new_block.
            end = start + h.new_count
            out[start:end] = new_block
        else:
            # `out` is the OLD file. We want to produce the NEW file.
            start = h.old_start - 1
            new_block = []
            for ln in h.lines:
                if ln.startswith("-"):
                    continue  # skip removed lines
                content = ln[1:] if ln[:1] in "+- " else ln
                new_block.append(content)
            end = start + h.old_count
            out[start:end] = new_block

    return out


# ---------------------------------------------------------------------------
# Function-level extraction
# ---------------------------------------------------------------------------

def find_enclosing_function(source: str, line_no_1based: int) -> Optional[ast.FunctionDef]:
    """
    Return the smallest FunctionDef (or AsyncFunctionDef) in `source`
    that contains the given 1-based line number. Returns None if the
    line is at module level.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None

    candidates: list[ast.FunctionDef] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.lineno <= line_no_1based <= node.end_lineno or line_no_1based:
                # use end_lineno if available (Python 3.8+)
                end = getattr(node, "end_lineno", node.lineno)
                if node.lineno <= line_no_1based <= end:
                    candidates.append(node)
    if not candidates:
        return None
    # smallest enclosing = the one with the smallest body span
    candidates.sort(key=lambda n: (getattr(n, "end_lineno", n.lineno) - n.lineno))
    return candidates[0]


def extract_function_source(source: str, func: ast.FunctionDef) -> str:
    """Return the source lines of `func` as a string, dedented to column 0."""
    lines = source.splitlines(keepends=False)
    start = func.lineno - 1  # 0-indexed
    end = getattr(func, "end_lineno", func.lineno)  # 1-indexed inclusive
    block = lines[start:end]
    # Dedent: find the minimum indentation among non-blank lines.
    non_blank = [ln for ln in block if ln.strip()]
    if not non_blank:
        return "\n".join(block) + "\n"
    min_indent = min(len(ln) - len(ln.lstrip()) for ln in non_blank)
    dedented = [ln[min_indent:] if len(ln) >= min_indent else ln for ln in block]
    return "\n".join(dedented) + "\n"


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def process_instance(inst: dict) -> Optional[dict]:
    """
    Convert one SWE-bench instance into a function-level BugCase.
    Returns None if the instance doesn't pass our filters.
    """
    patch = inst.get("patch", "")
    if not patch:
        return None

    files = parse_unified_diff(patch)
    # Filter 1: exactly one file touched.
    if len(files) != 1:
        return None
    file_path, hunks = files[0]
    # Only Python.
    if not file_path.endswith(".py"):
        return None
    # Filter 2: exactly one hunk.
    if len(hunks) != 1:
        return None
    hunk = hunks[0]
    # Filter 3: small change.
    added = sum(1 for ln in hunk.lines if ln.startswith("+"))
    removed = sum(1 for ln in hunk.lines if ln.startswith("-"))
    if added + removed > 20 or added + removed == 0:
        return None

    # Reconstruct the buggy and fixed versions of the file.
    # SWE-bench gives us `patch` (the forward diff). We don't have the
    # file content directly, but we have the test_patch and the FAIL_TO_PASS
    # tests. To get the file content, we'd need to clone the repo at
    # base_commit — too heavy for this PoC step.
    #
    # Workaround: many SWE-bench patches are nearly self-contained because
    # the hunk includes enough context lines. We reconstruct a *partial*
    # file from the hunk's context lines + the +/- lines, and treat the
    # enclosing function as the unit our engine works on.
    #
    # Build the "new" file from the hunk (post-patch):
    new_lines: list[str] = []
    old_lines: list[str] = []
    for ln in hunk.lines:
        if ln.startswith(" "):
            new_lines.append(ln[1:])
            old_lines.append(ln[1:])
        elif ln.startswith("+"):
            new_lines.append(ln[1:])
        elif ln.startswith("-"):
            old_lines.append(ln[1:])
    # We can't reliably get the full enclosing function from just the
    # hunk — we'd need the original file. So we synthesise a "function
    # stub" by treating the hunk's context + change as a standalone
    # code snippet. This is lossy but keeps the PoC moving.
    #
    # In a production setting, fetch the file from the repo at base_commit
    # via the GitHub API.

    # Try to detect a function signature in the context lines.
    func_match = None
    for ln in old_lines:
        m = re.match(r"^\s*def\s+(\w+)\s*\(", ln)
        if m:
            func_match = m
            break

    if func_match is None:
        # No function signature in the hunk context — skip for PoC.
        return None

    return {
        "id": f"swebench_{inst['instance_id']}",
        "repo": inst.get("repo", ""),
        "base_commit": inst.get("base_commit", ""),
        "problem_statement": inst.get("problem_statement", "")[:2000],  # cap length
        "file_path": file_path,
        "function_name": func_match.group(1),
        "buggy_code_snippet": "\n".join(old_lines),
        "fixed_code_snippet": "\n".join(new_lines),
        "fail_to_pass": inst.get("FAIL_TO_PASS", []),
        "pass_to_pass": inst.get("PASS_TO_PASS", [])[:20],  # cap
        "hunk_old_start": hunk.old_start,
        "hunk_old_count": hunk.old_count,
        "added_lines": added,
        "removed_lines": removed,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=200,
                        help="How many SWE-bench_Verified instances to scan (default 200).")
    parser.add_argument("--out", type=str, default="datasets/swebench_cases.json")
    parser.add_argument("--min", type=int, default=8,
                        help="Stop after collecting this many qualifying cases.")
    args = parser.parse_args()

    print(f"Loading SWE-bench_Verified (scanning up to {args.n} instances)…", flush=True)
    from datasets import load_dataset
    ds = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
    print(f"Dataset loaded: {len(ds)} instances total.", flush=True)

    cases: list[dict] = []
    scanned = 0
    for inst in ds:
        scanned += 1
        if scanned > args.n:
            break
        try:
            case = process_instance(inst)
        except Exception as e:
            print(f"  [skip] {inst.get('instance_id', '?')}: {e}", flush=True)
            continue
        if case is None:
            continue
        cases.append(case)
        print(f"  [ok]   {case['id']}: {case['function_name']}() in {case['file_path']} "
              f"(+{case['added_lines']}/-{case['removed_lines']})", flush=True)
        if len(cases) >= args.min:
            break

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"count": len(cases), "cases": cases}, f, indent=2, ensure_ascii=False)

    print(f"\nWrote {len(cases)} cases to {args.out}", flush=True)
    print(f"Scanned {scanned} instances, kept {len(cases)} ({(len(cases)/max(scanned,1))*100:.1f}%).", flush=True)


if __name__ == "__main__":
    main()
