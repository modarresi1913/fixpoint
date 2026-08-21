/**
 * Scalable SWE-bench runner — supports resume + incremental persistence.
 *
 * Designed for running over the full 30+ (or 500) case dataset without
 * losing progress to rate limits or timeouts.
 *
 * Key features:
 *   - Reads/writes a results.json after EVERY case (so a timeout loses
 *     at most one case of work).
 *   - Skips cases that already have a result in the JSON (resume).
 *   - Configurable pacing between cases (default 8s).
 *   - Configurable per-case LLM timeout (default 90s wall clock).
 *   - Writes the final report at the end, but ALSO writes an interim
 *     report after every case.
 */
import { runDetective } from "./agents/detective.js";
import { runQAEnhanced as runQA } from "./agents/qa_enhanced.js";
import { runPatcher } from "./agents/patcher.js";
import { makeInitialState, runGraph } from "./graph/engine.js";
import { loadSwebenchCases } from "./adapters/swebench.js";
import type { BugCase } from "./types/engine.js";
import { askLLMJson } from "./llm.js";
import { ensureDir, nowIso, writeFile } from "./utils.js";
import { promises as fs } from "node:fs";

const DOWNLOAD_DIR = "/home/z/my-project/download";
const LOGS_DIR = "/home/z/my-project/scripts/self-healing-engine/logs";
const DATASET_PATH =
  "/home/z/my-project/scripts/self-healing-engine/datasets/swebench_cases_v2_large.json";
const RESULTS_PATH = `${DOWNLOAD_DIR}/swebench_scale_results.json`;
const REPORT_PATH = `${DOWNLOAD_DIR}/swebench_scale_report.md`;

// ---------------------------------------------------------------------------
// Adapter: full function source as buggyCode
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
    `Full function source is shown. Only change the lines implicated by the bug.`;

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
// Result type & persistence
// ---------------------------------------------------------------------------

interface CaseResult {
  caseId: string;
  repo: string;
  functionName: string;
  filePath: string;
  addedLines: number;
  removedLines: number;
  detectiveTopHypothesis: string | null;
  qaExposedBug: boolean | null;
  qaHypothesesTried: number;
  patcherSummary: string | null;
  patcherReasoning: string | null;
  patcherOutput: string | null;
  verificationPassed: boolean | null;
  judgeVerdict: JudgeResponse | null;
  status: "fixed" | "partial" | "failed" | "no_patch" | "error";
  error?: string;
  durationMs: number;
}

interface ScaleResults {
  startedAt: string;
  endedAt: string | null;
  results: CaseResult[];
}

async function loadExistingResults(): Promise<ScaleResults> {
  try {
    const raw = await fs.readFile(RESULTS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { startedAt: nowIso(), endedAt: null, results: [] };
  }
}

async function saveResults(r: ScaleResults): Promise<void> {
  await ensureDir(DOWNLOAD_DIR);
  await writeFile(RESULTS_PATH, JSON.stringify(r, null, 2));
}

// ---------------------------------------------------------------------------
// Per-case runner (with timeout)
// ---------------------------------------------------------------------------

async function runOneCase(c: any, workDir: string, perCaseTimeoutMs: number): Promise<CaseResult> {
  const case_ = swebenchToBugCaseV2(c);
  const startMs = Date.now();
  console.log(`\n[${case_.id}] ${case_.description}`);

  const state = makeInitialState(case_, workDir);
  state.maxHypothesesToTry = 2; // reduce to fit per-case timeout

  try {
    const finalState = await runGraph(state, {
      maxIterations: 8,
      onStep: (s, _node) => {
        const last = s.trail[s.trail.length - 1];
        if (last) console.log(`  · ${last.summary}`);
      },
    });

    let judge: JudgeResponse | null = null;
    let status: CaseResult["status"] = "failed";

    if (finalState.patch && finalState.patch.newContent) {
      // Only run the judge if we still have time.
      if (Date.now() - startMs < perCaseTimeoutMs) {
        try {
          judge = await judgePatch(
            case_.buggyCode,
            case_.referenceFix,
            finalState.patch.newContent
          );
          if (judge.verdict === "equivalent") status = "fixed";
          else if (judge.verdict === "partial") status = "partial";
          else status = "failed";
        } catch (e: any) {
          console.warn(`  [judge] failed: ${e?.message || e}`);
          status = "failed";
        }
      } else {
        status = "failed"; // ran out of time for judge
      }
    } else {
      status = "no_patch";
    }

    const currentHyp = finalState.hypotheses.find(
      (h) => h.id === finalState.currentHypothesisId
    );
    const tr = currentHyp ? finalState.testResults[currentHyp.id] : null;
    const qaExposedAny = Object.values(finalState.testResults).some((t) => t.passed);

    // "verificationPassed" should only be true if the PATCHER ran AND its
    // re-run of the QA test passed. If the patcher didn't run (timeout
    // before reaching it), tr.passed reflects the QA stage, not the
    // patcher verification — so we set it to null.
    const verificationPassed =
      finalState.patch && tr ? tr.passed : null;

    return {
      caseId: case_.id,
      repo: c.repo,
      functionName: c.function_name,
      filePath: c.file_path,
      addedLines: c.added_lines,
      removedLines: c.removed_lines,
      detectiveTopHypothesis: finalState.hypotheses[0]?.title ?? null,
      qaExposedBug: qaExposedAny,
      qaHypothesesTried: Object.keys(finalState.testResults).length,
      patcherSummary: finalState.patch?.summary ?? null,
      patcherReasoning: finalState.patch?.reasoning ?? null,
      patcherOutput: finalState.patch?.newContent ?? null,
      verificationPassed: verificationPassed,
      judgeVerdict: judge,
      status,
      durationMs: Date.now() - startMs,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`  ✗ Error: ${msg}`);
    return {
      caseId: case_.id,
      repo: c.repo,
      functionName: c.function_name,
      filePath: c.file_path,
      addedLines: c.added_lines,
      removedLines: c.removed_lines,
      detectiveTopHypothesis: null,
      qaExposedBug: null,
      qaHypothesesTried: 0,
      patcherSummary: null,
      patcherReasoning: null,
      patcherOutput: null,
      verificationPassed: null,
      judgeVerdict: null,
      status: "error",
      error: msg,
      durationMs: Date.now() - startMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderReport(r: ScaleResults): string {
  const results = r.results;
  const total = results.length;
  const fixed = results.filter((x) => x.status === "fixed").length;
  const partial = results.filter((x) => x.status === "partial").length;
  const failed = results.filter((x) => x.status === "failed").length;
  const noPatch = results.filter((x) => x.status === "no_patch").length;
  const errors = results.filter((x) => x.status === "error").length;
  const qaExposed = results.filter((x) => x.qaExposedBug === true).length;
  const verifPassed = results.filter((x) => x.verificationPassed === true).length;
  const avgScore =
    results.reduce((s, x) => s + (x.judgeVerdict?.score ?? 0), 0) / Math.max(total, 1);

  const pct = (n: number, d: number) =>
    d === 0 ? "0%" : `${((n / d) * 100).toFixed(0)}%`;

  const lines: string[] = [];
  lines.push("# SWE-bench Scale Evaluation Report");
  lines.push("");
  lines.push(`**Started:** ${r.startedAt}`);
  lines.push(`**Ended:** ${r.endedAt || "(in progress)"}`);
  lines.push(`**Dataset:** SWE-bench_Verified (filtered, single-hunk single-file Python)`);
  lines.push(`**Cases evaluated:** ${total}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| ✅ Equivalent to gold fix | ${fixed} / ${total} (${pct(fixed, total)}) |`);
  lines.push(`| 🟡 Partial match | ${partial} / ${total} (${pct(partial, total)}) |`);
  lines.push(`| ❌ Wrong fix | ${failed} / ${total} (${pct(failed, total)}) |`);
  lines.push(`| ⚪ No patch produced | ${noPatch} / ${total} (${pct(noPatch, total)}) |`);
  lines.push(`| 🔥 Errors | ${errors} / ${total} (${pct(errors, total)}) |`);
  lines.push(`| **QA test exposed the bug** | ${qaExposed} / ${total} (${pct(qaExposed, total)}) |`);
  lines.push(`| **Patcher verification passed** | ${verifPassed} / ${total} (${pct(verifPassed, total)}) |`);
  lines.push(`| **Average semantic score** | **${avgScore.toFixed(2)} / 1.00** |`);
  lines.push("");

  if (total === 0) {
    lines.push("_(no cases have completed yet)_");
    return lines.join("\n");
  }

  lines.push("## Per-case breakdown");
  lines.push("");
  lines.push("| Case | Repo | Function | Status | Score | QA? | Verif? | Detective's top hypothesis |");
  lines.push("|------|------|----------|--------|-------|-----|--------|----------------------------|");
  for (const x of results) {
    const score = x.judgeVerdict?.score.toFixed(2) ?? "—";
    const qa = x.qaExposedBug === null ? "—" : x.qaExposedBug ? "✓" : "✗";
    const vp = x.verificationPassed === null ? "—" : x.verificationPassed ? "✓" : "✗";
    const icon = {
      fixed: "✅", partial: "🟡", failed: "❌", no_patch: "⚪", error: "🔥",
    }[x.status] || "?";
    const dh = (x.detectiveTopHypothesis || "—").slice(0, 45).replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| \`${x.caseId}\` | ${x.repo} | \`${x.functionName}()\` | ${icon} ${x.status} | ${score} | ${qa} | ${vp} | ${dh} |`);
  }
  lines.push("");

  // Aggregate stats per repo.
  const byRepo: Record<string, CaseResult[]> = {};
  for (const x of results) {
    (byRepo[x.repo] ||= []).push(x);
  }
  if (Object.keys(byRepo).length > 1) {
    lines.push("## Per-repo summary");
    lines.push("");
    lines.push("| Repo | Cases | Fixed | QA exposed | Avg score |");
    lines.push("|------|-------|-------|------------|-----------|");
    for (const [repo, xs] of Object.entries(byRepo)) {
      const f = xs.filter((x) => x.status === "fixed").length;
      const q = xs.filter((x) => x.qaExposedBug === true).length;
      const a = xs.reduce((s, x) => s + (x.judgeVerdict?.score ?? 0), 0) / xs.length;
      lines.push(`| ${repo} | ${xs.length} | ${f} | ${q} | ${a.toFixed(2)} |`);
    }
    lines.push("");
  }

  lines.push("## Detailed verdicts");
  lines.push("");
  for (const x of results) {
    lines.push(`### \`${x.caseId}\``);
    lines.push("");
    lines.push(`- **Repo:** ${x.repo}`);
    lines.push(`- **File:** \`${x.filePath}\``);
    lines.push(`- **Function:** \`${x.functionName}()\``);
    lines.push(`- **Diff size:** +${x.addedLines}/-${x.removedLines}`);
    lines.push(`- **Duration:** ${(x.durationMs / 1000).toFixed(1)}s`);
    if (x.error) lines.push(`- **Error:** ${x.error}`);
    lines.push(`- **Detective's top hypothesis:** ${x.detectiveTopHypothesis || "—"}`);
    lines.push(`- **QA exposed the bug?** ${x.qaExposedBug === null ? "—" : x.qaExposedBug ? "yes ✓" : "no ✗"} (in ${x.qaHypothesesTried} hypothesis attempt(s))`);
    lines.push(`- **Patcher verification passed?** ${x.verificationPassed === null ? "—" : x.verificationPassed ? "yes ✓" : "no ✗"}`);
    lines.push(`- **Patcher's summary:** ${x.patcherSummary || "—"}`);
    lines.push(`- **Patcher's reasoning:** ${x.patcherReasoning || "—"}`);
    const j = x.judgeVerdict;
    lines.push(`- **Judge verdict:** ${j?.verdict ?? "—"} (score ${j?.score ?? "—"})`);
    lines.push(`- **Judge reasoning:** ${j?.reasoning ?? "—"}`);
    lines.push("");
    if (x.patcherOutput) {
      lines.push("```python");
      lines.push(x.patcherOutput.trim());
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await ensureDir(DOWNLOAD_DIR);
  await ensureDir(LOGS_DIR);

  const MAX_CASES = parseInt(process.env.SWEBENCH_MAX_CASES || "30", 10);
  const PACING_MS = parseInt(process.env.SWEBENCH_PACING_MS || "8000", 10);
  const PER_CASE_TIMEOUT_MS = parseInt(
    process.env.SWEBENCH_PER_CASE_TIMEOUT_MS || "120000",
    10
  );

  console.log("Loading SWE-bench cases (large dataset, full function source)…");
  const allCases = await loadSwebenchCases(DATASET_PATH);
  const cases = allCases.slice(0, MAX_CASES);
  console.log(
    `Loaded ${allCases.length} cases; will run up to ${cases.length}. ` +
      `Pacing=${PACING_MS}ms, per-case timeout=${PER_CASE_TIMEOUT_MS / 1000}s.`
  );

  // Load existing results (resume support).
  let scaleResults = await loadExistingResults();
  if (scaleResults.results.length > 0) {
    console.log(`Resuming: ${scaleResults.results.length} cases already have results.`);
  } else {
    scaleResults.startedAt = nowIso();
  }

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    // Skip if already done.
    if (scaleResults.results.some((r) => r.caseId === c.id)) {
      console.log(`\n[${i + 1}/${cases.length}] ${c.id}: SKIP (already has result)`);
      continue;
    }
    console.log(`\n[${i + 1}/${cases.length}] ───────────`);
    const workDir = `${LOGS_DIR}/swebench_scale_${c.id}_${Date.now()}`;
    const result = await runOneCase(c, workDir, PER_CASE_TIMEOUT_MS);
    scaleResults.results.push(result);
    scaleResults.endedAt = nowIso();
    await saveResults(scaleResults);

    // Write an interim report after every case.
    await writeFile(REPORT_PATH, renderReport(scaleResults));

    // Pace between cases.
    if (i < cases.length - 1) {
      console.log(`  (pacing ${PACING_MS / 1000}s…)`);
      await new Promise((r) => setTimeout(r, PACING_MS));
    }
  }

  scaleResults.endedAt = nowIso();
  await saveResults(scaleResults);
  await writeFile(REPORT_PATH, renderReport(scaleResults));

  const fixed = scaleResults.results.filter((r) => r.status === "fixed").length;
  const qaExposed = scaleResults.results.filter((r) => r.qaExposedBug === true).length;
  const avgScore =
    scaleResults.results.reduce((s, r) => s + (r.judgeVerdict?.score ?? 0), 0) /
    Math.max(scaleResults.results.length, 1);

  console.log("\n" + "═".repeat(60));
  console.log(`SWE-bench scale evaluation complete.`);
  console.log(`  Total cases: ${scaleResults.results.length}`);
  console.log(`  ✅ Equivalent: ${fixed}`);
  console.log(`  🧪 QA exposed bug: ${qaExposed}`);
  console.log(`  📊 Avg score:  ${avgScore.toFixed(2)} / 1.00`);
  console.log(`  📄 Report:     ${REPORT_PATH}`);
  console.log(`  📊 JSON:       ${RESULTS_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
