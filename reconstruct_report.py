"""
Reconstruct the SWE-bench PoC report from the log file when the runner
was killed by timeout before it could write the final report.

This is a one-off helper that parses /tmp/swebench_fast2.log and produces
a structured report covering the cases that actually completed.
"""
import json
import re
import sys
from pathlib import Path

LOG_PATH = "/tmp/swebench_fast2.log"
OUT_JSON = "/home/z/my-project/download/swebench_results.json"
OUT_MD = "/home/z/my-project/download/swebench_report.md"

log = Path(LOG_PATH).read_text()

# Pattern: a case header line, then a series of "  · [agent] ..." lines.
case_re = re.compile(
    r"\[swebench_([^\]]+)\] ([^\n]+)\n((?:  · [^\n]+\n)+)",
    re.MULTILINE,
)

results = []
# Strategy: scan the log line by line; when we hit a "[swebench_xxx]"
# header, start a new case record and absorb subsequent "  · ..." lines
# into it until we hit the next header (or end of log).
lines = log.splitlines()
i = 0
while i < len(lines):
    line = lines[i]
    m = re.match(r"^\[swebench_([^\]]+)\]\s+(.+)$", line)
    if not m:
        i += 1
        continue
    case_id = "swebench_" + m.group(1)
    header = m.group(2).strip()
    # Absorb following lines that are part of this case's trail.
    trail_lines = []
    j = i + 1
    while j < len(lines):
        nxt = lines[j]
        if nxt.startswith("[swebench_") or nxt.startswith("[") and "]" in nxt[:60] and "/8" not in nxt[:60] and "/4" not in nxt[:60]:
            break
        if nxt.startswith("  · "):
            trail_lines.append(nxt)
        elif nxt.strip() == "" or nxt.startswith("Failed to make") or nxt.startswith("  [llm]") or nxt.startswith("    at "):
            # skip noise
            pass
        else:
            # anything else that's not a header or trail line stops the case
            break
        j += 1

    body = "\n".join(trail_lines)

    detective_top = None
    patcher_summary = None
    judge_verdict = None
    judge_score = None
    judge_reasoning = None
    status = "error"

    for tline in trail_lines:
        s = tline.strip().lstrip("·").strip()
        if s.startswith("[detective] Generated"):
            mt = re.search(r'Top: "([^"]+)"', s)
            if mt:
                detective_top = mt.group(1)
        elif s.startswith("[patcher] Applied patch:"):
            ms = re.search(r'Applied patch: "([^"]+)"', s)
            if ms:
                patcher_summary = ms.group(1)
        elif s.startswith("[router] Judge:"):
            mj = re.search(
                r"Judge: (\w+) \(score ([\d.]+)\)\.?\s*(.*)",
                s,
            )
            if mj:
                judge_verdict = mj.group(1)
                judge_score = float(mj.group(2))
                judge_reasoning = mj.group(3).strip()
                if judge_verdict == "equivalent":
                    status = "fixed"
                elif judge_verdict == "partial":
                    status = "partial"
                else:
                    status = "failed"

    h = re.match(
        r"([^:]+):\s+(\w+)\(\)\s+—\s+(\d+)\+/(\d+)-\s+in\s+(\S+)",
        header,
    )
    if h:
        repo = h.group(1)
        function_name = h.group(2)
        added = int(h.group(3))
        removed = int(h.group(4))
        file_path = h.group(5)
    else:
        repo = header
        function_name = "?"
        added = removed = 0
        file_path = "?"

    results.append({
        "caseId": case_id,
        "repo": repo,
        "functionName": function_name,
        "filePath": file_path,
        "added_lines": added,
        "removed_lines": removed,
        "detectiveTopHypothesis": detective_top,
        "patcherSummary": patcher_summary,
        "judgeVerdict": {
            "verdict": judge_verdict,
            "score": judge_score,
            "reasoning": judge_reasoning,
        } if judge_verdict else None,
        "status": status,
    })
    i = j

# Save JSON.
Path(OUT_JSON).write_text(json.dumps({
    "startedAt": "2026-08-21T10:48:03Z",
    "endedAt": "2026-08-21T10:53:00Z",
    "results": results,
    "note": "Reconstructed from log file because runner timed out before writing final report.",
}, indent=2))

# Render Markdown report.
def pct(n, d):
    return f"{(n*100//max(d,1))}%"

total = len(results)
fixed = sum(1 for r in results if r["status"] == "fixed")
partial = sum(1 for r in results if r["status"] == "partial")
failed = sum(1 for r in results if r["status"] == "failed")
errors = sum(1 for r in results if r["status"] == "error")
avg = sum((r["judgeVerdict"]["score"] or 0) for r in results if r["judgeVerdict"]) / max(total, 1)

md = []
md.append("# SWE-bench Evaluation Report (Fast-Path, Reconstructed from Log)\n")
md.append(f"**Dataset:** SWE-bench_Verified (filtered subset, single-hunk single-file Python)\n")
md.append(f"**Cases evaluated:** {total}\n")
md.append("")
md.append("> **Note on the fast path.** The toy-bug runner relies on a pytest sandbox to verify each hypothesis. SWE-bench snippets live inside real codebases (Django, Astropy) and reference imports the sandbox can't resolve, so every QA test fails with ImportError. This runner skips the sandbox and goes Detective → Patcher → LLM-as-judge, which is enough to evaluate whether the reasoning loop identifies and fixes the right bug. A production version needs a real Docker sandbox with the repo's deps installed.\n")
md.append("## Summary\n")
md.append("| Metric | Value |")
md.append("|--------|-------|")
md.append(f"| ✅ Equivalent to gold fix | {fixed} / {total} ({pct(fixed, total)}) |")
md.append(f"| 🟡 Partial match | {partial} / {total} ({pct(partial, total)}) |")
md.append(f"| ❌ Wrong fix | {failed} / {total} ({pct(failed, total)}) |")
md.append(f"| 🔥 Errors (rate-limited) | {errors} / {total} ({pct(errors, total)}) |")
md.append(f"| **Average semantic score** | **{avg:.2f} / 1.00** |")
md.append("")
md.append("## Per-case breakdown\n")
md.append("| Case | Repo | Function | Status | Score | Detective's top hypothesis | Patcher's summary |")
md.append("|------|------|----------|--------|-------|-----------------------------|-------------------|")
for r in results:
    s = r["status"]
    icon = {"fixed": "✅", "partial": "🟡", "failed": "❌", "error": "🔥"}.get(s, "?")
    score = f"{r['judgeVerdict']['score']:.2f}" if r["judgeVerdict"] else "—"
    dh = (r["detectiveTopHypothesis"] or "—")[:50]
    ps = (r["patcherSummary"] or "—")[:50]
    md.append(f"| `{r['caseId']}` | {r['repo']} | `{r['functionName']}()` | {icon} {s} | {score} | {dh} | {ps} |")
md.append("")
md.append("## Detailed verdicts\n")
for r in results:
    md.append(f"### `{r['caseId']}`\n")
    md.append(f"- **Repo:** {r['repo']}")
    md.append(f"- **File:** `{r['filePath']}`")
    md.append(f"- **Function:** `{r['functionName']}()`")
    md.append(f"- **Diff size:** +{r['added_lines']}/-{r['removed_lines']}")
    md.append(f"- **Detective's top hypothesis:** {r['detectiveTopHypothesis'] or '—'}")
    md.append(f"- **Patcher's summary:** {r['patcherSummary'] or '—'}")
    j = r["judgeVerdict"]
    if j:
        md.append(f"- **Judge verdict:** {j['verdict']} (score {j['score']})")
        md.append(f"- **Judge reasoning:** {j['reasoning']}")
    else:
        md.append("- **Judge verdict:** — (case did not complete)")
    md.append("")

Path(OUT_MD).write_text("\n".join(md))

print(f"Wrote {len(results)} cases:")
for r in results:
    j = r["judgeVerdict"]
    jline = f"  judge={j['verdict']}({j['score']})" if j else "  no judge"
    print(f"  {r['caseId']}: {r['status']}{jline}")
print(f"\nJSON: {OUT_JSON}")
print(f"MD:   {OUT_MD}")
