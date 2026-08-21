/**
 * SWE-bench evaluation runner — "fast path" variant.
 *
 * Why a different runner?
 * ----------------------
 * The toy-bug runner relies on the QA Agent's pytest sandbox to verify
 * each hypothesis. That works for self-contained Python functions, but
 * SWE-bench snippets live inside real codebases (Django, Astropy, …)
 * and reference imports the sandbox can't resolve. Result: every QA
 * test fails with ImportError before it can even reach the bug, so the
 * loop discards every hypothesis and never reaches the Patcher.
 *
 * The fast path skips the QA sandbox entirely and goes:
 *
 *   detective  →  patcher  →  LLM-as-judge (vs. gold fix)
 *
 * The Detective still produces 3 ranked hypotheses (so we can see
 * whether it identifies the right area), but the Patcher is invoked
 * directly on the top hypothesis, and the final verdict is a semantic
 * equivalence check against the gold reference fix.
 *
 * This is exactly the kind of adaptation the PoC is meant to surface:
 * the closed-loop design is sound, but the sandbox needs to be a real
 * Docker container with the repo's dependencies installed before it
 * can verify real-world bugs.
 */
import { runDetective } from "./agents/detective.js";
import { runPatcher } from "./agents/patcher.js";
import { loadSwebenchCases, swebenchToBugCase } from "./adapters/swebench.js";
import type { BugCase, EngineState, Hypothesis, ReasoningStep } from "./types/engine.js";
import { askLLMJson } from "./llm.js";
import { ensureDir, nowIso, writeFile } from "./utils.js";

const DOWNLOAD_DIR = "/home/z/my-project/download";
const LOGS_DIR = "/home/z/my-project/scripts/self-healing-engine/logs";
const DATASET_PATH =
  "/home/z/my-project/scripts/self-healing-engine/datasets/swebench_cases.json";

// ---------------------------------------------------------------------------
// A minimal "synthetic test" the Patcher can target. Instead of running
// real pytest, we ask the LLM to write a 1-paragraph "behavioural spec"
// describing what the fixed code should do. The Patcher gets this as the
// "test" it must make pass (conceptually).
// ---------------------------------------------------------------------------

async function synthesiseTestSpec(case_: BugCase, h: Hypothesis): Promise<string> {
  const sys =
    "You are a QA engineer. Given a bug, a hypothesis, and a partial code " +
    "snippet from a real codebase, write a 3-5 sentence behavioural spec " +
    "describing what the FIXED code should do. Do NOT write actual code — " +
    "just the spec. Respond as plain text.";
  const user =
    `## Problem statement\n${case_.symptom}\n\n` +
    `## Hypothesis\n${h.title}: ${h.reasoning}\n\n` +
    `## Proposed fix (English)\n${h.proposedFix}\n\n` +
    `## Buggy snippet\n\`\`\`python\n${case_.buggyCode}\n\`\`\`\n\n` +
    `Write the behavioural spec for the fixed code.`;
  // Use plain askLLM (not JSON) to avoid parsing issues with prose.
  const { askLLM } = await import("./llm.js");
  return await askLLM(sys, user, { thinking: true });
}

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
// Per-case runner
// ---------------------------------------------------------------------------

interface CaseResult {
  caseId: string;
  repo: string;
  functionName: string;
  filePath: string;
  detectiveTopHypothesis: string | null;
  detectiveHypotheses: { title: string; confidence: number }[];
  patcherSummary: string | null;
  patcherReasoning: string | null;
  patcherOutput: string | null;
  judgeVerdict: JudgeResponse | null;
  status: "fixed" | "partial" | "failed" | "no_patch" | "error";
  error?: string;
}

async function runOneCase(
  swebenchCase: Awaited<ReturnType<typeof loadSwebenchCases>>[number],
  workDir: string
): Promise<CaseResult> {
  const case_ = swebenchToBugCase(swebenchCase);
  console.log(`\n[${case_.id}] ${case_.description}`);

  const trail: ReasoningStep[] = [];
  const push = (s: ReasoningStep) => {
    trail.push(s);
    console.log(`  · [${s.agent}] ${s.summary}`);
  };

  try {
    // 1. Detective
    push({
      agent: "detective",
      timestamp: nowIso(),
      summary: `Started case "${case_.id}"`,
    });
    const { hypotheses } = await runDetective(case_);
    push({
      agent: "detective",
      timestamp: nowIso(),
      summary: `Generated ${hypotheses.length} hypotheses. Top: "${hypotheses[0].title}" (${(hypotheses[0].confidence * 100).toFixed(0)}%)`,
    });

    // 2. Build a synthetic test spec for the top hypothesis.
    const top = hypotheses[0];
    const testSpec = await synthesiseTestSpec(case_, top);
    push({
      agent: "qa",
      timestamp: nowIso(),
      summary: `Synthesised behavioural spec (${testSpec.length} chars) for top hypothesis.`,
    });

    // 3. Patcher — use the test spec as the "test file" content.
    //    The Patcher will treat it as the target behaviour to satisfy.
    const { patch, verification } = await runPatcher(
      case_,
      top,
      `# Behavioural spec for the fixed code (synthesised by QA agent):\n"""\n${testSpec}\n"""`,
      workDir
    );
    push({
      agent: "patcher",
      timestamp: nowIso(),
      summary: `Applied patch: "${patch.summary}". Sandbox verification: ${verification.passed ? "PASS ✓" : "FAIL ✗ (expected — sandbox can't import real-codebase deps)"} (${verification.passedCount}/${verification.passedCount + verification.failedCount})`,
    });

    // 4. Judge against gold.
    const judge = await judgePatch(
      case_.buggyCode,
      case_.referenceFix,
      patch.newContent
    );
    push({
      agent: "router",
      timestamp: nowIso(),
      summary: `Judge: ${judge.verdict} (score ${judge.score}). ${judge.reasoning}`,
    });

    let status: CaseResult["status"] = "failed";
    if (judge.verdict === "equivalent") status = "fixed";
    else if (judge.verdict === "partial") status = "partial";
    else status = "failed";

    // Persist a per-case markdown file.
    await writeFile(
      `${workDir}/case_summary.md`,
      renderCaseSummary(case_, hypotheses, patch, judge, trail)
    );

    return {
      caseId: case_.id,
      repo: swebenchCase.repo,
      functionName: swebenchCase.function_name,
      filePath: swebenchCase.file_path,
      detectiveTopHypothesis: top.title,
      detectiveHypotheses: hypotheses.map((h) => ({
        title: h.title,
        confidence: Number(h.confidence.toFixed(3)),
      })),
      patcherSummary: patch.summary,
      patcherReasoning: patch.reasoning,
      patcherOutput: patch.newContent,
      judgeVerdict: judge,
      status,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`  ✗ Error: ${msg}`);
    return {
      caseId: case_.id,
      repo: swebenchCase.repo,
      functionName: swebenchCase.function_name,
      filePath: swebenchCase.file_path,
      detectiveTopHypothesis: null,
      detectiveHypotheses: [],
      patcherSummary: null,
      patcherReasoning: null,
      patcherOutput: null,
      judgeVerdict: null,
      status: "error",
      error: msg,
    };
  }
}

function renderCaseSummary(
  case_: BugCase,
  hypotheses: Hypothesis[],
  patch: { summary: string; reasoning: string; newContent: string },
  judge: JudgeResponse,
  trail: ReasoningStep[]
): string {
  const lines: string[] = [];
  lines.push(`# ${case_.id}`);
  lines.push("");
  lines.push(`**Repo:** ${case_.description}`);
  lines.push(`**Status:** ${judge.verdict} (score ${judge.score})`);
  lines.push("");
  lines.push("## Buggy snippet");
  lines.push("```python");
  lines.push(case_.buggyCode.trim());
  lines.push("```");
  lines.push("");
  lines.push("## Gold reference fix");
  lines.push("```python");
  lines.push(case_.referenceFix.trim());
  lines.push("```");
  lines.push("");
  lines.push("## Patcher output");
  lines.push(`**Summary:** ${patch.summary}`);
  lines.push(`**Reasoning:** ${patch.reasoning}`);
  lines.push("");
  lines.push("```python");
  lines.push(patch.newContent.trim());
  lines.push("```");
  lines.push("");
  lines.push("## Judge verdict");
  lines.push(`- **Verdict:** ${judge.verdict}`);
  lines.push(`- **Score:** ${judge.score}`);
  lines.push(`- **Reasoning:** ${judge.reasoning}`);
  lines.push("");
  lines.push("## Detective's hypotheses");
  for (const h of hypotheses) {
    lines.push(`- **${h.title}** — confidence ${(h.confidence * 100).toFixed(0)}%`);
    lines.push(`  - ${h.reasoning}`);
    lines.push(`  - Proposed fix: ${h.proposedFix}`);
  }
  lines.push("");
  lines.push("## Reasoning trail");
  for (const s of trail) {
    lines.push(`- [${s.agent}] ${s.timestamp} — ${s.summary}`);
  }
  return lines.join("\n");
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
  const score =
    results.reduce((s, r) => s + (r.judgeVerdict?.score ?? 0), 0) /
    Math.max(results.length, 1);

  const lines: string[] = [];
  lines.push("# SWE-bench Evaluation Report (Fast-Path)");
  lines.push("");
  lines.push(`**Started:** ${startedAt}`);
  lines.push(`**Ended:** ${endedAt}`);
  lines.push(`**Dataset:** SWE-bench_Verified (filtered subset, single-hunk single-file Python)`);
  lines.push(`**Cases evaluated:** ${results.length}`);
  lines.push("");
  lines.push("> **Note on the fast path.** The toy-bug runner relies on a pytest sandbox to verify each hypothesis. SWE-bench snippets live inside real codebases (Django, Astropy) and reference imports the sandbox can't resolve, so every QA test fails with ImportError. This runner skips the sandbox and goes Detective → Patcher → LLM-as-judge, which is enough to evaluate whether the reasoning loop identifies and fixes the right bug. A production version needs a real Docker sandbox with the repo's deps installed.");
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
  lines.push(`| **Average semantic score** | **${score.toFixed(2)} / 1.00** |`);
  lines.push("");
  lines.push("## Per-case breakdown");
  lines.push("");
  lines.push("| Case | Repo | Function | Status | Score | Detective's top hypothesis | Patcher's summary |");
  lines.push("|------|------|----------|--------|-------|-----------------------------|-------------------|");
  for (const r of results) {
    lines.push(
      `| \`${r.caseId}\` | ${r.repo} | \`${r.functionName}()\` | ${statusIcon(r.status)} ${r.status} | ${r.judgeVerdict?.score.toFixed(2) ?? "—"} | ${truncateForTable(r.detectiveTopHypothesis)} | ${truncateForTable(r.patcherSummary)} |`
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
    if (r.error) {
      lines.push(`- **Error:** ${r.error}`);
    }
    lines.push(`- **Detective's top hypothesis:** ${r.detectiveTopHypothesis ?? "—"}`);
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

  console.log("Loading SWE-bench cases…");
  const allCases = await loadSwebenchCases(DATASET_PATH);
  // Limit to first N cases for time-budget reasons. Each case makes 3-4
  // LLM calls (detective + qa-spec + patcher + judge), so 4 cases = ~16
  // calls, comfortably within rate limits if we pace ourselves.
  const MAX_CASES = parseInt(process.env.SWEBENCH_MAX_CASES || "4", 10);
  const cases = allCases.slice(0, MAX_CASES);
  console.log(
    `Loaded ${allCases.length} cases; running first ${cases.length} (set SWEBENCH_MAX_CASES to change).`
  );

  const startedAt = nowIso();
  const results: CaseResult[] = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const workDir = `${LOGS_DIR}/swebench_fast_${c.id}_${Date.now()}`;
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
        detectiveTopHypothesis: null,
        detectiveHypotheses: [],
        patcherSummary: null,
        patcherReasoning: null,
        patcherOutput: null,
        judgeVerdict: null,
        status: "error",
        error: err?.message || String(err),
      });
    }
    // Pace: wait 5s between cases to avoid burst-rate-limiting.
    if (i < cases.length - 1) {
      console.log("  (pacing 5s…)");
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  const endedAt = nowIso();

  const report = renderReport(results, startedAt, endedAt);
  const reportPath = `${DOWNLOAD_DIR}/swebench_report.md`;
  await writeFile(reportPath, report);

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
