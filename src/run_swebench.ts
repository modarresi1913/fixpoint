/**
 * SWE-bench evaluation runner.
 *
 * Differences from the toy-bug runner (run_demo.ts):
 *
 * 1. SWE-bench snippets are partial views of real functions in real
 *    codebases (Django, Astropy, etc.). The buggy code references types
 *    and imports we don't have. So the QA sandbox will frequently fail
 *    to even import the code — that's expected and OK.
 *
 * 2. We CAN'T rely on "test passes on patched code" as the success
 *    criterion, because the patched code also references missing imports.
 *    Instead, we use a *semantic equivalence check*: ask the LLM to
 *    compare the patcher's output against the gold reference fix and
 *    judge whether they're semantically equivalent.
 *
 * 3. The reasoning loop still runs (Detective → QA → Patcher) so we can
 *    see whether the detective identifies the right area and whether the
 *    patcher produces a sensible fix. The "verdict" at the end is the
 *    semantic-equivalence check, not the pytest run.
 *
 * This mirrors how SWE-bench itself is evaluated: the official metric is
 * "does the FAIL_TO_PASS test pass on the patched repo", which requires
 * a full Docker setup. For PoC we approximate with LLM-as-judge.
 */
import { runDetective } from "./agents/detective.js";
import { runQA } from "./agents/qa.js";
import { runPatcher } from "./agents/patcher.js";
import { makeInitialState, runGraph } from "./graph/engine.js";
import { loadSwebenchCases, swebenchToBugCase } from "./adapters/swebench.js";
import type { EngineState } from "./types/engine.js";
import { askLLMJson } from "./llm.js";
import { ensureDir, nowIso, writeFile } from "./utils.js";

const DOWNLOAD_DIR = "/home/z/my-project/download";
const LOGS_DIR = "/home/z/my-project/scripts/self-healing-engine/logs";
const DATASET_PATH =
  "/home/z/my-project/scripts/self-healing-engine/datasets/swebench_cases.json";

// ---------------------------------------------------------------------------
// LLM-as-judge: semantic equivalence between patcher output and gold fix
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are a strict code reviewer judging whether two code changes are semantically equivalent.

You will see:
- BUGGY: the original buggy code snippet.
- GOLD:   the reference fix (ground truth from the actual PR that closed the issue).
- PROPOSED: the fix produced by an automated patcher.

Judge whether PROPOSED achieves the same semantic effect as GOLD: does it fix the same bug, in the same way, without introducing new behaviour?

Respond with JSON in EXACTLY this shape:
{
  "verdict": "equivalent" | "partial" | "wrong" | "no_fix",
  "score": 0.0,
  "reasoning": "1-3 sentences."
}

- "equivalent" (score 1.0): PROPOSED fixes the bug the same way as GOLD.
- "partial"    (score 0.5): PROPOSED addresses the right area but is incomplete or has side effects.
- "wrong"      (score 0.0): PROPOSED changes the wrong thing or doesn't fix the bug.
- "no_fix"     (score 0.0): PROPOSED is identical to BUGGY (no change was made).

Be strict. A change that "looks plausible" but doesn't match GOLD's intent is "wrong", not "partial".`;

interface JudgeResponse {
  verdict: "equivalent" | "partial" | "wrong" | "no_fix";
  score: number;
  reasoning: string;
}

async function judgePatch(
  buggy: string,
  gold: string,
  proposed: string
): Promise<JudgeResponse> {
  const userPrompt =
    `## BUGGY (original)\n\`\`\`python\n${buggy}\n\`\`\`\n\n` +
    `## GOLD (reference fix)\n\`\`\`python\n${gold}\n\`\`\`\n\n` +
    `## PROPOSED (patcher output)\n\`\`\`python\n${proposed}\n\`\`\`\n\n` +
    `Judge the proposed fix.`;
  return await askLLMJson<JudgeResponse>(JUDGE_SYSTEM_PROMPT, userPrompt, {
    thinking: true,
  });
}

// ---------------------------------------------------------------------------
// Per-case runner
// ---------------------------------------------------------------------------

interface CaseResult {
  caseId: string;
  repo: string;
  functionName: string;
  detectiveTopHypothesis: string | null;
  patcherSummary: string | null;
  patcherOutput: string | null;
  judgeVerdict: JudgeResponse | null;
  reasoningTrailLength: number;
  status: "fixed" | "partial" | "failed" | "no_patch";
}

async function runOneCase(
  swebenchCase: Awaited<ReturnType<typeof loadSwebenchCases>>[number],
  workDir: string
): Promise<CaseResult> {
  const case_ = swebenchToBugCase(swebenchCase);
  const state = makeInitialState(case_, workDir);

  console.log(`\n[${case_.id}] ${case_.description}`);

  // Run the closed-loop reasoning. Sandbox failures are tolerated by
  // the graph (the QA node records them but doesn't abort).
  const finalState = await runGraph(state, {
    maxIterations: 10,
    onStep: (s, _node) => {
      const last = s.trail[s.trail.length - 1];
      if (last) console.log(`  · ${last.summary}`);
    },
  });

  // Judge the patch (or lack thereof) against the gold fix.
  let judge: JudgeResponse | null = null;
  let status: CaseResult["status"] = "failed";

  if (finalState.patch && finalState.patch.newContent) {
    judge = await judgePatch(
      case_.buggyCode,
      case_.referenceFix,
      finalState.patch.newContent
    );
    if (judge.verdict === "equivalent") status = "fixed";
    else if (judge.verdict === "partial") status = "partial";
    else status = "failed";
  } else {
    status = "no_patch";
  }

  const result: CaseResult = {
    caseId: case_.id,
    repo: swebenchCase.repo,
    functionName: swebenchCase.function_name,
    detectiveTopHypothesis: finalState.hypotheses[0]?.title ?? null,
    patcherSummary: finalState.patch?.summary ?? null,
    patcherOutput: finalState.patch?.newContent ?? null,
    judgeVerdict: judge,
    reasoningTrailLength: finalState.trail.length,
    status,
  };

  console.log(`  → verdict: ${status}${judge ? ` (${judge.verdict}, score ${judge.score})` : ""}`);
  if (judge) console.log(`    ${judge.reasoning}`);

  return result;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderReport(
  results: CaseResult[],
  startedAt: string,
  endedAt: string
): string {
  const fixed = results.filter((r) => r.status === "fixed").length;
  const partial = results.filter((r) => r.status === "partial").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const noPatch = results.filter((r) => r.status === "no_patch").length;
  const score =
    results.reduce((s, r) => s + (r.judgeVerdict?.score ?? 0), 0) /
    Math.max(results.length, 1);

  const lines: string[] = [];
  lines.push("# SWE-bench Evaluation Report");
  lines.push("");
  lines.push(`**Started:** ${startedAt}`);
  lines.push(`**Ended:** ${endedAt}`);
  lines.push(`**Dataset:** SWE-bench_Verified (filtered subset)`);
  lines.push(`**Cases evaluated:** ${results.length}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| ✅ Equivalent to gold fix | ${fixed} / ${results.length} (${pct(fixed, results.length)}) |`);
  lines.push(`| 🟡 Partial match | ${partial} / ${results.length} (${pct(partial, results.length)}) |`);
  lines.push(`| ❌ Wrong fix | ${failed} / ${results.length} (${pct(failed, results.length)}) |`);
  lines.push(`| ⚪ No patch produced | ${noPatch} / ${results.length} (${pct(noPatch, results.length)}) |`);
  lines.push(`| **Average semantic score** | **${score.toFixed(2)} / 1.00** |`);
  lines.push("");
  lines.push("## Per-case breakdown");
  lines.push("");
  lines.push("| Case | Repo | Function | Status | Score | Detective's top hypothesis |");
  lines.push("|------|------|----------|--------|-------|-----------------------------|");
  for (const r of results) {
    lines.push(
      `| \`${r.caseId}\` | ${r.repo} | \`${r.functionName}()\` | ${statusIcon(r.status)} ${r.status} | ${r.judgeVerdict?.score.toFixed(2) ?? "—"} | ${truncateForTable(r.detectiveTopHypothesis)} |`
    );
  }
  lines.push("");
  lines.push("## Detailed verdicts");
  lines.push("");
  for (const r of results) {
    lines.push(`### \`${r.caseId}\``);
    lines.push("");
    lines.push(`- **Repo:** ${r.repo}`);
    lines.push(`- **Function:** \`${r.functionName}()\``);
    lines.push(`- **Detective's top hypothesis:** ${r.detectiveTopHypothesis ?? "—"}`);
    lines.push(`- **Patcher's summary:** ${r.patcherSummary ?? "—"}`);
    lines.push(`- **Judge verdict:** ${r.judgeVerdict?.verdict ?? "—"} (score ${r.judgeVerdict?.score ?? "—"})`);
    lines.push(`- **Judge reasoning:** ${r.judgeVerdict?.reasoning ?? "—"}`);
    lines.push("");
    if (r.patcherOutput) {
      lines.push("```python");
      lines.push(r.patcherOutput.trim());
      lines.push("```");
      lines.push("");
    }
    lines.push("");
  }
  return lines.join("\n");
}

function pct(n: number, d: number): string {
  if (d === 0) return "0%";
  return `${((n / d) * 100).toFixed(0)}%`;
}

function statusIcon(s: CaseResult["status"]): string {
  switch (s) {
    case "fixed":
      return "✅";
    case "partial":
      return "🟡";
    case "failed":
      return "❌";
    case "no_patch":
      return "⚪";
  }
}

function truncateForTable(s: string | null, n = 60): string {
  if (!s) return "—";
  s = s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await ensureDir(DOWNLOAD_DIR);
  await ensureDir(LOGS_DIR);

  console.log("Loading SWE-bench cases…");
  const cases = await loadSwebenchCases(DATASET_PATH);
  console.log(`Loaded ${cases.length} cases from ${DATASET_PATH}`);

  const startedAt = nowIso();
  const results: CaseResult[] = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const workDir = `${LOGS_DIR}/swebench_${c.id}_${Date.now()}`;
    console.log(`\n[${i + 1}/${cases.length}] ───────────`);
    try {
      const r = await runOneCase(c, workDir);
      results.push(r);
    } catch (err: any) {
      console.error(`  ✗ Case failed with error: ${err?.message || err}`);
      results.push({
        caseId: c.id,
        repo: c.repo,
        functionName: c.function_name,
        detectiveTopHypothesis: null,
        patcherSummary: null,
        patcherOutput: null,
        judgeVerdict: null,
        reasoningTrailLength: 0,
        status: "failed",
      });
    }
  }
  const endedAt = nowIso();

  const report = renderReport(results, startedAt, endedAt);
  const reportPath = `${DOWNLOAD_DIR}/swebench_report.md`;
  await writeFile(reportPath, report);

  // Also dump raw results as JSON for downstream analysis.
  const jsonPath = `${DOWNLOAD_DIR}/swebench_results.json`;
  await writeFile(jsonPath, JSON.stringify({ startedAt, endedAt, results }, null, 2));

  const fixed = results.filter((r) => r.status === "fixed").length;
  const partial = results.filter((r) => r.status === "partial").length;
  const avgScore =
    results.reduce((s, r) => s + (r.judgeVerdict?.score ?? 0), 0) /
    Math.max(results.length, 1);

  console.log("\n" + "═".repeat(60));
  console.log(`SWE-bench PoC evaluation complete.`);
  console.log(`  ✅ Equivalent: ${fixed}/${results.length}`);
  console.log(`  🟡 Partial:    ${partial}/${results.length}`);
  console.log(`  📊 Avg score:  ${avgScore.toFixed(2)} / 1.00`);
  console.log(`  📄 Report:     ${reportPath}`);
  console.log(`  📊 JSON:       ${jsonPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
