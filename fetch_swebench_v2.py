"""
Improved SWE-bench fetcher.

Key improvement over fetch_swebench.py:
  - We now clone the actual repo at base_commit and extract the FULL
    function source (not just the hunk snippet). This gives the engine
    real code to work on.
  - We also extract the full file content (post-bug, pre-fix) so the
    Patcher has full context.

If git is unavailable or the clone fails (no network, repo too big),
we fall back to the snippet-only mode of the original fetcher.
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


# ---------------------------------------------------------------------------
# Reuse the diff parsing from fetch_swebench.py
# ---------------------------------------------------------------------------

@dataclass
class Hunk:
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    lines: list[str]


HUNK_HEADER_RE = re.compile(
    r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$"
)


def parse_unified_diff(diff: str) -> list[tuple[str, list[Hunk]]]:
    files: list[tuple[str, list[Hunk]]] = []
    current_file: Optional[str] = None
    current_hunks: list[Hunk] = []
    current_hunk: Optional[Hunk] = None
    in_hunk = False

    for line in diff.splitlines(keepends=False):
        if line.startswith("diff --git"):
            if current_file is not None:
                files.append((current_file, current_hunks))
            current_file = None
            current_hunks = []
            current_hunk = None
            in_hunk = False
            continue
        if line.startswith("--- "):
            continue
        if line.startswith("+++ "):
            path = line[4:].strip()
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
                current_hunks.append(current_hunk)
                current_hunk = None
                in_hunk = False

    if current_hunk is not None:
        current_hunks.append(current_hunk)
    if current_file is not None:
        files.append((current_file, current_hunks))

    return files


# ---------------------------------------------------------------------------
# Function extraction (now from full file source)
# ---------------------------------------------------------------------------

def find_enclosing_function(source: str, line_no_1based: int) -> Optional[ast.FunctionDef]:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    candidates = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            end = getattr(node, "end_lineno", node.lineno)
            if node.lineno <= line_no_1based <= end:
                candidates.append(node)
    if not candidates:
        return None
    candidates.sort(key=lambda n: (getattr(n, "end_lineno", n.lineno) - n.lineno))
    return candidates[0]


def extract_function_source(source: str, func: ast.FunctionDef) -> str:
    lines = source.splitlines(keepends=False)
    start = func.lineno - 1
    end = getattr(func, "end_lineno", func.lineno)
    block = lines[start:end]
    non_blank = [ln for ln in block if ln.strip()]
    if not non_blank:
        return "\n".join(block) + "\n"
    min_indent = min(len(ln) - len(ln.lstrip()) for ln in non_blank)
    dedented = [ln[min_indent:] if len(ln) >= min_indent else ln for ln in block]
    return "\n".join(dedented) + "\n"


# ---------------------------------------------------------------------------
# Repo cloning (the new bit)
# ---------------------------------------------------------------------------

# Cache of repo -> path so we don't reclone per-case.
_REPO_CACHE: dict[str, str] = {}


def ensure_repo_cloned(repo: str, cache_dir: str) -> Optional[str]:
    """
    Shallow-clone `repo` (e.g. 'django/django') into cache_dir.
    Returns the local path, or None if cloning fails.
    """
    if repo in _REPO_CACHE:
        return _REPO_CACHE[repo]

    name = repo.replace("/", "_")
    local = os.path.join(cache_dir, name)
    if os.path.isdir(local) and os.path.isdir(os.path.join(local, ".git")):
        _REPO_CACHE[repo] = local
        return local

    url = f"https://github.com/{repo}.git"
    print(f"  cloning {repo}…", flush=True)
    try:
        # Shallow clone with no checkout — we'll checkout the specific
        # commit per case to keep disk usage low.
        result = subprocess.run(
            ["git", "clone", "--filter=blob:none", "--no-checkout", url, local],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if result.returncode != 0:
            print(f"  clone failed: {result.stderr[:200]}", flush=True)
            return None
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"  clone error: {e}", flush=True)
        return None

    _REPO_CACHE[repo] = local
    return local


def read_file_at_commit(repo_path: str, commit: str, file_path: str) -> Optional[str]:
    """Use `git show` to read a file's content at a specific commit."""
    try:
        result = subprocess.run(
            ["git", "show", f"{commit}:{file_path}"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None
        return result.stdout
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def process_instance(inst: dict, repo_cache: str) -> Optional[dict]:
    patch = inst.get("patch", "")
    if not patch:
        return None

    files = parse_unified_diff(patch)
    if len(files) != 1:
        return None
    file_path, hunks = files[0]
    if not file_path.endswith(".py"):
        return None
    if len(hunks) != 1:
        return None
    hunk = hunks[0]
    added = sum(1 for ln in hunk.lines if ln.startswith("+"))
    removed = sum(1 for ln in hunk.lines if ln.startswith("-"))
    if added + removed > 30 or added + removed == 0:
        return None

    repo = inst.get("repo", "")
    base_commit = inst.get("base_commit", "")

    # Try to fetch the full file at base_commit. This is the BIG improvement:
    # we get the real buggy code, not just the snippet.
    repo_path = ensure_repo_cloned(repo, repo_cache)
    full_file_buggy: Optional[str] = None
    if repo_path:
        # Checkout the commit (so git show works for it).
        # Actually `git show commit:path` works without checkout.
        full_file_buggy = read_file_at_commit(repo_path, base_commit, file_path)

    if not full_file_buggy:
        # Fall back to snippet mode.
        buggy_lines = []
        fixed_lines = []
        for ln in hunk.lines:
            if ln.startswith(" "):
                buggy_lines.append(ln[1:])
                fixed_lines.append(ln[1:])
            elif ln.startswith("+"):
                fixed_lines.append(ln[1:])
            elif ln.startswith("-"):
                buggy_lines.append(ln[1:])
        return {
            "id": f"swebench_{inst['instance_id']}",
            "repo": repo,
            "base_commit": base_commit,
            "problem_statement": inst.get("problem_statement", "")[:2000],
            "file_path": file_path,
            "function_name": "(snippet)",
            "buggy_code_full": None,
            "buggy_code_snippet": "\n".join(buggy_lines),
            "fixed_code_snippet": "\n".join(fixed_lines),
            "buggy_code_function": "\n".join(buggy_lines),
            "fixed_code_function": "\n".join(fixed_lines),
            "fail_to_pass": inst.get("FAIL_TO_PASS", []),
            "pass_to_pass": inst.get("PASS_TO_PASS", [])[:20],
            "hunk_old_start": hunk.old_start,
            "added_lines": added,
            "removed_lines": removed,
            "source": "snippet_fallback",
        }

    # Full-file mode: extract the enclosing function.
    try:
        tree = ast.parse(full_file_buggy)
    except SyntaxError:
        return None

    func_node = find_enclosing_function(full_file_buggy, hunk.old_start)
    if func_node is None:
        return None

    buggy_func = extract_function_source(full_file_buggy, func_node)

    # Apply the patch forward to get the fixed version of the SAME function.
    # We work on the full file lines, then re-extract the function.
    full_lines = full_file_buggy.splitlines(keepends=False)
    # Note: splitlines() loses trailing newline info; we'll add it back.
    fixed_full_lines = list(full_lines)
    # Apply the hunk: replace old_start..old_start+old_count with the new block.
    new_block = []
    for ln in hunk.lines:
        if ln.startswith("-"):
            continue
        content = ln[1:] if ln[:1] in "+- " else ln
        new_block.append(content)
    start_idx = hunk.old_start - 1
    end_idx = start_idx + hunk.old_count
    fixed_full_lines[start_idx:end_idx] = new_block
    fixed_full = "\n".join(fixed_full_lines) + "\n"

    # Re-extract the fixed function (line numbers may have shifted).
    try:
        fixed_tree = ast.parse(fixed_full)
    except SyntaxError:
        return None

    # Find the function with the same name in the fixed tree.
    fixed_func_node = None
    for node in ast.walk(fixed_tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_node.name:
            fixed_func_node = node
            break
    if fixed_func_node is None:
        return None
    fixed_func = extract_function_source(fixed_full, fixed_func_node)

    return {
        "id": f"swebench_{inst['instance_id']}",
        "repo": repo,
        "base_commit": base_commit,
        "problem_statement": inst.get("problem_statement", "")[:2000],
        "file_path": file_path,
        "function_name": func_node.name,
        "buggy_code_full": full_file_buggy,
        "buggy_code_snippet": None,
        "fixed_code_snippet": None,
        "buggy_code_function": buggy_func,
        "fixed_code_function": fixed_func,
        "fail_to_pass": inst.get("FAIL_TO_PASS", []),
        "pass_to_pass": inst.get("PASS_TO_PASS", [])[:20],
        "hunk_old_start": hunk.old_start,
        "added_lines": added,
        "removed_lines": removed,
        "source": "full_repo_clone",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=200)
    parser.add_argument("--out", type=str, default="datasets/swebench_cases_v2.json")
    parser.add_argument("--min", type=int, default=8)
    parser.add_argument("--repo-cache", type=str, default="/tmp/swebench_repos")
    args = parser.parse_args()

    os.makedirs(args.repo_cache, exist_ok=True)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    print(f"Loading SWE-bench_Verified (scanning up to {args.n})…", flush=True)
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
            case = process_instance(inst, args.repo_cache)
        except Exception as e:
            print(f"  [skip] {inst.get('instance_id', '?')}: {e}", flush=True)
            continue
        if case is None:
            continue
        cases.append(case)
        src_tag = case.get("source", "?")
        print(
            f"  [ok]   {case['id']}: {case['function_name']}() in {case['file_path']} "
            f"(+{case['added_lines']}/-{case['removed_lines']}, src={src_tag})",
            flush=True,
        )
        if len(cases) >= args.min:
            break

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"count": len(cases), "cases": cases}, f, indent=2, ensure_ascii=False)

    full_count = sum(1 for c in cases if c.get("source") == "full_repo_clone")
    snippet_count = sum(1 for c in cases if c.get("source") == "snippet_fallback")
    print(f"\nWrote {len(cases)} cases to {args.out}", flush=True)
    print(f"  full_repo_clone:  {full_count}", flush=True)
    print(f"  snippet_fallback: {snippet_count}", flush=True)


if __name__ == "__main__":
    main()
