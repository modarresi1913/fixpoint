"""Reconstruct v2 report — improved regex."""
import json, re
from pathlib import Path

LOG_PATH = "/tmp/swebench_v2_run.log"
LOGS_DIR = "/home/z/my-project/scripts/self-healing-engine/logs"
OUT_JSON = "/home/z/my-project/download/swebench_v2_results.json"
OUT_MD = "/home/z/my-project/download/swebench_v2_report.md"

log = Path(LOG_PATH).read_text()
lines = log.splitlines()

# Find all case header line indices.
case_starts = []
for i, line in enumerate(lines):
    if line.startswith("[swebench_"):
        case_starts.append(i)

# For each case, slice from its header to the next case header.
results = []
for idx, start in enumerate(case_starts):
    end = case_starts[idx + 1] if idx + 1 < len(case_starts) else len(lines)
    block = lines[start:end]

    header = block[0]
    m = re.match(r"^\[swebench_([^\]]+)\]\s+(.+)$", header)
    if not m:
        continue
    case_id = "swebench_" + m.group(1)
    header_text = m.group(2).strip()

    # Parse trail lines.
    detective_top = None
    qa_exposed_per_hyp = []
    patcher_summary = None
    verification_passed = None
    status = "no_patch"

    for line in block[1:]:
        s = line.strip()
        # Trail lines look like "  · summary text"
        if s.startswith("· "):
            s = s[2:].strip()
        elif s.startswith("·"):
            s = s[1:].strip()
        # Now match by content (the log doesn't include agent prefix).
        if s.startswith("Generated ") and "Top:" in s:
            mt = re.search(r'Top: "([^"]+)"', s)
            if mt:
                detective_top = mt.group(1)
        elif s.startswith("Wrote test for"):
            if "Bug-exposing test: YES" in s:
                qa_exposed_per_hyp.append(True)
            elif "Bug-exposing test: NO" in s:
                qa_exposed_per_hyp.append(False)
        elif s.startswith("Applied patch:"):
            ms = re.search(r'Applied patch: "([^"]+)"', s)
            if ms:
                patcher_summary = ms.group(1)
            if "Verification: PASS" in s:
                verification_passed = True
            elif "Verification: FAIL" in s:
                verification_passed = False
        elif s.startswith("→ verdict:"):
            mv = re.search(r"verdict:\s*(\w+)", s)
            if mv:
                v = mv.group(1)
                status = {"fixed": "fixed", "partial": "partial", "failed": "failed", "no_patch": "no_patch"}.get(v, "error")

    qa_exposed = any(qa_exposed_per_hyp) if qa_exposed_per_hyp else None

    # Parse header.
    h = re.match(r"([^:]+):\s+(\w+)\(\)\s+—\s+(\d+)\+/(\d+)-\s+in\s+(\S+)", header_text)
    if h:
        repo = h.group(1)
        function_name = h.group(2)
        added = int(h.group(3))
        removed = int(h.group(4))
        file_path = h.group(5)
    else:
        repo = function_name = file_path = "?"
        added = removed = 0

    # Read patcher output from disk if available.
    patcher_output = None
    patcher_reasoning = None
    log_dirs = sorted(Path(LOGS_DIR).glob(f"swebench_v2_{case_id}_*"))
    if log_dirs:
        ld = log_dirs[-1]
        patcher_dirs = list(ld.glob("patcher_h*"))
        if patcher_dirs:
            pd = patcher_dirs[-1]
            main_py = pd / "main.py"
            if main_py.exists():
                patcher_output = main_py.read_text()
            summary_md = pd / "patch_summary.md"
            if summary_md.exists():
                t = summary_md.read_text()
                rm = re.search(r"\*\*Reasoning:\*\*\s*(.+)", t)
                if rm:
                    patcher_reasoning = rm.group(1).strip()

    results.append({
        "caseId": case_id,
        "repo": repo,
        "functionName": function_name,
        "filePath": file_path,
        "added_lines": added,
        "removed_lines": removed,
        "detectiveTopHypothesis": detective_top,
        "qaExposedBug": qa_exposed,
        "qaExposesCount": sum(1 for x in qa_exposed_per_hyp if x),
        "qaHypothesesTried": len(qa_exposed_per_hyp),
        "patcherSummary": patcher_summary,
        "patcherReasoning": patcher_reasoning,
        "patcherOutput": patcher_output,
        "verificationPassed": verification_passed,
        "judgeVerdict": None,  # v2 didn't reach judge step before timeout
        "status": status,
    })

# Save JSON.
Path(OUT_JSON).write_text(json.dumps({
    "startedAt": "2026-08-21T11:07:40Z",
    "endedAt": "2026-08-21T11:17:00Z",
    "results": results,
    "note": "Reconstructed from log + on-disk logs because runner timed out before final write. Judge step did not run.",
}, indent=2))

# Render Markdown.
def pct(n, d):
    return f"{(n * 100 // max(d, 1))}%"

total = len(results)
qa_exposed_count = sum(1 for r in results if r["qaExposedBug"] is True)
verif_passed_count = sum(1 for r in results if r["verificationPassed"] is True)

md = []
md.append("# SWE-bench Evaluation Report (Enhanced — Full Function Source + Mocked QA)")
md.append("")
md.append(f"**Dataset:** SWE-bench_Verified (filtered, single-hunk single-file Python, Astropy repos)")
md.append(f"**Cases evaluated:** {total}")
md.append("")
md.append("> **What changed vs the fast-path run.** This runner uses the FULL function source (extracted via `git show` at base_commit) instead of just the hunk snippet. The QA Agent now writes tests that mock external dependencies (`unittest.mock.patch`), so the closed-loop reasoning (Detective → QA → Patcher → Verify) actually runs end-to-end on real-world code from Astropy/Django — the QA sandbox can verify each hypothesis instead of skipping it.")
md.append("")
md.append("> **Note: the LLM-as-judge step did not run** — the runner timed out before reaching it. The `status` field reflects what the closed loop concluded (no_patch = the loop exhausted all 3 hypotheses without producing a verified patch). The patcher output for each case is still captured on disk.")
md.append("")
md.append("## Summary")
md.append("")
md.append("| Metric | Value |")
md.append("|--------|-------|")
md.append(f"| **QA test exposed the bug (at least once)** | {qa_exposed_count} / {total} ({pct(qa_exposed_count, total)}) |")
md.append(f"| **Patcher verification passed** | {verif_passed_count} / {total} ({pct(verif_passed_count, total)}) |")
md.append(f"| Cases that produced a verified patch | {verif_passed_count} / {total} ({pct(verif_passed_count, total)}) |")
md.append(f"| Cases that exhausted hypotheses (no_patch) | {total - verif_passed_count} / {total} ({pct(total - verif_passed_count, total)}) |")
md.append("")
md.append("## Per-case breakdown")
md.append("")
md.append("| Case | Function | QA exposed? | QA hyps tried | Verif passed? | Detective's top hypothesis |")
md.append("|------|----------|-------------|---------------|---------------|----------------------------|")
for r in results:
    qa = "—" if r["qaExposedBug"] is None else ("✓ yes" if r["qaExposedBug"] else "✗ no")
    vp = "—" if r["verificationPassed"] is None else ("✓ yes" if r["verificationPassed"] else "✗ no")
    dh = (r["detectiveTopHypothesis"] or "—")[:50]
    md.append(f"| `{r['caseId']}` | `{r['functionName']}()` | {qa} | {r['qaHypothesesTried']} | {vp} | {dh} |")
md.append("")
md.append("## Detailed verdicts")
md.append("")
for r in results:
    md.append(f"### `{r['caseId']}`")
    md.append("")
    md.append(f"- **Repo:** {r['repo']}")
    md.append(f"- **File:** `{r['filePath']}`")
    md.append(f"- **Function:** `{r['functionName']}()`")
    md.append(f"- **Diff size:** +{r['added_lines']}/-{r['removed_lines']}")
    md.append(f"- **Detective's top hypothesis:** {r['detectiveTopHypothesis'] or '—'}")
    md.append(f"- **QA exposed the bug?** {'—' if r['qaExposedBug'] is None else ('yes ✓ (in ' + str(r['qaExposesCount']) + ' of ' + str(r['qaHypothesesTried']) + ' hypotheses)' if r['qaExposedBug'] else 'no ✗')}")
    md.append(f"- **Patcher verification passed?** {'—' if r['verificationPassed'] is None else ('yes ✓' if r['verificationPassed'] else 'no ✗')}")
    md.append(f"- **Patcher's summary:** {r['patcherSummary'] or '—'}")
    md.append(f"- **Patcher's reasoning:** {r['patcherReasoning'] or '—'}")
    md.append("")
    if r["patcherOutput"]:
        md.append("```python")
        md.append(r["patcherOutput"].strip())
        md.append("```")
        md.append("")

Path(OUT_MD).write_text("\n".join(md))

print(f"Wrote {len(results)} cases:")
for r in results:
    qa = "qa=—" if r["qaExposedBug"] is None else (f"qa=Y({r['qaExposesCount']}/{r['qaHypothesesTried']})" if r["qaExposedBug"] else "qa=N")
    vp = "vp=—" if r["verificationPassed"] is None else ("vp=Y" if r["verificationPassed"] else "vp=N")
    print(f"  {r['caseId']}: {r['status']} {qa} {vp}")
print(f"\nJSON: {OUT_JSON}")
print(f"MD:   {OUT_MD}")
