/**
 * Enhanced SWE-bench runner — uses full function source + enhanced QA Agent.
 *
 * Improvements over run_swebench_fast.ts:
 *   1. Uses swebench_cases_v2.json which has the FULL function source
 *      (not just a hunk snippet). The Detective sees real code.
 *   2. Uses the enhanced QA Agent that mocks external deps, so the
 *      closed loop (Detective → QA → Patcher) actually runs end-to-end
 *      on real-world code, not just the fast path.
 *   3. Still uses LLM-as-judge for the final verdict, since the real
 *      SWE-bench test suite requires a full Docker setup.
 *
 * The closed loop can now actually VERIFY hypotheses via the sandbox:
 *   - QA writes a test with mocks → runs on buggy code → should FAIL.
 *   - If it fails (exposes bug) → Patcher applies fix → re-runs test → should PASS.
 *   - If it doesn't fail (mocking incomplete or hypothesis wrong) → backtrack.
 */
import { runDetective } from "./agents/detective.js";
import { runQAEnhanced } from "./agents/qa_enhanced.js";
import { runPatcher } from "./agents/patcher.js";
import { makeInitialState, runGraph, type NodeName } from "./graph/engine.js";
import { loadSwebenchCases } from "./adapters/swebench.js";
import type { BugCase } from "./types/engine.js";
import { askLLMJson } from "./llm.js";
import { ensureDir, nowIso, writeFile } from "./utils.js";
import { promises as fs } from "node:fs";

const DOWNLOAD_DIR = "/home/z/my-project/download";
const LOGS_DIR = "/home/z/my-project/scripts/self-healing-engine/logs";
const DATASET_PATH =
  "/home/z/my-project/scripts/self-healing-engine/datasets/swebench_cases_v2.json";

// ---------------------------------------------------------------------------
// Adapter override: use the FULL function source as buggyCode, not the snippet.
// ---------------------------------------------------------------------------

function swebenchToBugCaseV2(c: any): BugCase {
  const buggyCode = c.buggy_code_function || c.buggy_code_snippet || "";
  const fixedCode = c.fixed_code_function || c.fixed_code_snippet || "";

  const failingTests = (c.fail_to_pass || [])
    .filter((t: unknown) => typeof t === "string" && t.trim().length > 0)
    .slice(0, 3)
    .map((t: string) => `  - ${t}`)
    .join("\n");

  const symptom =
    `Issue from ${c.repo}:\n${truncate(c.problem_statement, 800)}\n\n` +
    `Failing tests after the bug:\n${failingTests || "  (none specified)"}`;

  const specification =
    `Function \`${c.function_name}\` in \`${c.file_path}\` (repo: ${c.repo}). ` +
    `The function is part of a real-world codebase. The code shown below is the ` +
    `FULL function source (extracted via git show at base_commit). Use it as-is. ` +
    `Only change the lines implicated by the bug; preserve everything else.`;

  return {
    id: c.id,
    language: "python",
    description: `${c.repo}: ${c.function_name}() — ${c.added_lines}+/${c.removed_lines}- in ${c.file_path}`,
    buggyCode,
    symptom,
    referenceFix: fixedCode,
    specification,
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

// ---------------------------------------------------------------------------
// LLM-as-judge
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are a strict code reviewer judging whether two code changes are semantically equivalent.

You will see:
- BUGGY: the original buggy function source.
- GOLD:   the reference fix (ground truth from the actual PR).
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

Be strict. A change that "looks plausible" but doesn't match GOLD's intent is "wrong", not "partial".

Output valid JSON only. No markdown fences.`;

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
// Per-case runner — uses the real closed-loop graph
// ---------------------------------------------------------------------------

interface CaseResult {
  caseId: string;
  repo: string;
  functionName: string;
  filePath: string;
  source: string;
  detectiveTopHypothesis: string | null;
  detectiveHypotheses: { title: string; confidence: number }[];
  qaExposedBug: boolean | null;
  patcherSummary: string | null;
  patcherReasoning: string | null;
  patcherOutput: string | null;
  verificationPassed: boolean | null;
  judgeVerdict: JudgeResponse | null;
  status: "fixed" | "partial" | "failed" | "no_patch" | "error";
  error?: string;
  reasoningTrailLength: number;
}

async function runOneCase(c: any, workDir: string): Promise<CaseResult> {
  const case_ = swebenchToBugCaseV2(c);
  console.log(`\n[${case_.id}] ${case_.description}`);
  console.log(`  source: ${c.source}, function: ${c.function_name}, +${c.added_lines}/-${c.removed_lines}`);

  const state = makeInitialState(case_, workDir);
  state.maxHypothesesToTry = 3;

  try {
    const finalState = await runGraph(state, {
      maxIterations: 10,
      onStep: (s, _node) => {
        const last = s.trail[s.trail.length - 1];
        if (last) console.log(`  · ${last.summary}`);
      },
    });

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

    const topHyp = finalState.hypotheses[0];
    const currentHyp = finalState.hypotheses.find(
      (h) => h.id === finalState.currentHypothesisId
    );
    const tr = currentHyp ? finalState.testResults[currentHyp.id] : null;

    const result: CaseResult = {
      caseId: case_.id,
      repo: c.repo,
      functionName: c.function_name,
      filePath: c.file_path,
      source: c.source,
      detectiveTopHypothesis: topHyp?.title ?? null,
      detectiveHypotheses: finalState.hypotheses.map((h) => ({
        title: h.title,
        confidence: Number(h.confidence.toFixed(3)),
      })),
      qaExposedBug: tr?.passed ?? null,
      patcherSummary: finalState.patch?.summary ?? null,
      patcherReasoning: finalState.patch?.reasoning ?? null,
      patcherOutput: finalState.patch?.newContent ?? null,
      verificationPassed: tr?.passed ?? null,
      judgeVerdict: judge,
      status,
      reasoningTrailLength: finalState.trail.length,
    };

    console.log(`  → verdict: ${status}${judge ? ` (${judge.verdict}, score ${judge.score})` : ""}`);
    if (judge) console.log(`    ${judge.reasoning}`);

    return result;
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`  ✗ Error: ${msg}`);
    return {
      caseId: case_.id,
      repo: c.repo,
      functionName: c.function_name,
      filePath: c.file_path,
      source: c.source,
      detectiveTopHypothesis: null,
      detectiveHypotheses: [],
      qaExposedBug: null,
      patcherSummary: null,
      patcherReasoning: null,
      patcherOutput: null,
      verificationPassed: null,
      judgeVerdict: null,
      status: "error",
      error: msg,
      reasoningTrailLength: 0,
    };
  }
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
  const errors = results.filter((r) => r.status === "error").length;
  const qaExposed = results.filter((r) => r.qaExposedBug === true).length;
  const score =
    results.reduce((s, r) => s + (r.judgeVerdict?.score ?? 0), 0) /
    Math.max(results.length, 1);

  const lines: string[] = [];
  lines.push("# SWE-bench Evaluation Report (Enhanced — Full Function Source + Mocked QA)");
  lines.push("");
  lines.push(`**Started:** ${startedAt}`);
  lines.push(`**Ended:** ${endedAt}`);
  lines.push(`**Dataset:** SWE-bench_Verified (filtered subset, single-hunk single-file Python)`);
  lines.push(`**Cases evaluated:** ${results.length}`);
  lines.push("");
  lines.push("> **What changed vs the fast-path run.** This runner uses the FULL function source (extracted via `git show` at base_commit) instead of just the hunk snippet. The QA Agent now writes tests that mock external dependencies, so the closed-loop reasoning (Detective → QA → Patcher) actually runs end-to-end on real-world code — the QA sandbox can verify each hypothesis instead of skipping it.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| ✅ Equivalent to gold fix | ${fixed} / ${results.length} (${pct(fixed, results.length)}) |`);
  lines.push(`| 🟡 Partial match | ${partial} / ${results.length} (${pct(partial, results.length)}) |`);
  lines.push(`| ❌ Wrong fix | ${failed} / ${results.length} (${pct(failed, results.length)}) |`);
  lines.push(`| ⚪ No patch produced | ${noPatch} / ${results.length} (${pct(noPatch, results.length)}) |`);
  lines.push(`| 🔥 Errors | ${errors} / ${results.length} (${pct(errors, results.length)}) |`);
  lines.push(`| **QA test exposed the bug** | ${qaExposed} / ${results.length} (${pct(qaExposed, results.length)}) |`);
  lines.push(`| **Average semantic score** | **${score.toFixed(2)} / 1.00** |`);
  lines.push("");
  lines.push("## Per-case breakdown");
  lines.push("");
  lines.push("| Case | Repo | Function | Status | Score | QA exposed bug? | Detective's top hypothesis |");
  lines.push("|------|------|----------|--------|-------|-----------------|----------------------------|");
  for (const r of results) {
    lines.push(
      `| \`${r.caseId}\` | ${r.repo} | \`${r.functionName}()\` | ${statusIcon(r.status)} ${r.status} | ${r.judgeVerdict?.score.toFixed(2) ?? "—"} | ${r.qaExposedBug === null ? "—" : r.qaExposedBug ? "✓ yes" : "✗ no"} | ${truncateForTable(r.detectiveTopHypothesis)} |`
    );
  }
  lines.push("");
  lines.push("## Detailed verdicts");
  lines.push("");
  for (const r of results) {
    lines.push(`### \`${r.caseId}\``);
    lines.push("");
    lines.push(`- **Repo:** ${r.repo}`);
    lines.push(`- **File:** \`${r.filePath}\``);
    lines.push(`- **Function:** \`${r.functionName}()\``);
    lines.push(`- **Source:** ${r.source}`);
    if (r.error) {
      lines.push(`- **Error:** ${r.error}`);
    }
    lines.push(`- **Detective's top hypothesis:** ${r.detectiveTopHypothesis ?? "—"}`);
    lines.push(`- **QA exposed the bug?** ${r.qaExposedBug === null ? "—" : r.qaExposedBug ? "yes ✓" : "no ✗"}`);
    lines.push(`- **Verification passed?** ${r.verificationPassed === null ? "—" : r.verificationPassed ? "yes ✓" : "no ✗"}`);
    lines.push(`- **Patcher's summary:** ${r.patcherSummary ?? "—"}`);
    lines.push(`- **Patcher's reasoning:** ${r.patcherReasoning ?? "—"}`);
    lines.push(`- **Judge verdict:** ${r.judgeVerdict?.verdict ?? "—"} (score ${r.judgeVerdict?.score ?? "—"})`);
    lines.push(`- **Judge reasoning:** ${r.judgeVerdict?.reasoning ?? "—"}`);
    lines.push("");
    if (r.patcherOutput) {
      lines.push("```python");
      lines.push(r.patcherOutput.trim());
      lines.push("```");
      lines.push("");
    }
    if (r.detectiveHypotheses.length > 0) {
      lines.push("<details><summary>All detective hypotheses</summary>");
      lines.push("");
      for (const h of r.detectiveHypotheses) {
        lines.push(`- **${h.title}** — confidence ${(h.confidence * 100).toFixed(0)}%`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
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
    case "error":
      return "🔥";
  }
}

function truncateForTable(s: string | null, n = 50): string {
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

  console.log("Loading SWE-bench cases (v2, full function source)…");
  // loadSwebenchCases already normalises fail_to_pass / pass_to_pass
  // (HF stores them as JSON-encoded strings).
  const allCases = await loadSwebenchCases(DATASET_PATH);
  const MAX_CASES = parseInt(process.env.SWEBENCH_MAX_CASES || "8", 10);
  const cases = allCases.slice(0, MAX_CASES);
  console.log(
    `Loaded ${allCases.length} cases; running first ${cases.length} (set SWEBENCH_MAX_CASES to change).`
  );

  const startedAt = nowIso();
  const results: CaseResult[] = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const workDir = `${LOGS_DIR}/swebench_v2_${c.id}_${Date.now()}`;
    console.log(`\n[${i + 1}/${cases.length}] ───────────`);
    try {
      const r = await runOneCase(c, workDir);
      results.push(r);
    } catch (err: any) {
      console.error(`  ✗ Outer error: ${err?.message || err}`);
      results.push({
        caseId: c.id,
        repo: c.repo,
        functionName: c.function_name,
        filePath: c.file_path,
        source: c.source ?? "unknown",
        detectiveTopHypothesis: null,
        detectiveHypotheses: [],
        qaExposedBug: null,
        patcherSummary: null,
        patcherReasoning: null,
        patcherOutput: null,
        verificationPassed: null,
        judgeVerdict: null,
        status: "error",
        error: err?.message || String(err),
        reasoningTrailLength: 0,
      });
    }
    // Pace between cases.
    if (i < cases.length - 1) {
      console.log("  (pacing 5s…)");
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  const endedAt = nowIso();

  const report = renderReport(results, startedAt, endedAt);
  const reportPath = `${DOWNLOAD_DIR}/swebench_v2_report.md`;
  await writeFile(reportPath, report);

  const jsonPath = `${DOWNLOAD_DIR}/swebench_v2_results.json`;
  await writeFile(jsonPath, JSON.stringify({ startedAt, endedAt, results }, null, 2));

  const fixed = results.filter((r) => r.status === "fixed").length;
  const partial = results.filter((r) => r.status === "partial").length;
  const qaExposed = results.filter((r) => r.qaExposedBug === true).length;
  const avgScore =
    results.reduce((s, r) => s + (r.judgeVerdict?.score ?? 0), 0) /
    Math.max(results.length, 1);

  console.log("\n" + "═".repeat(60));
  console.log(`SWE-bench Enhanced PoC evaluation complete.`);
  console.log(`  ✅ Equivalent: ${fixed}/${results.length}`);
  console.log(`  🟡 Partial:    ${partial}/${results.length}`);
  console.log(`  🧪 QA exposed bug: ${qaExposed}/${results.length}`);
  console.log(`  📊 Avg score:  ${avgScore.toFixed(2)} / 1.00`);
  console.log(`  📄 Report:     ${reportPath}`);
  console.log(`  📊 JSON:       ${jsonPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
