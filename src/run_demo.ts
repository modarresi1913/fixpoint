/**
 * Demo runner — runs the full self-healing loop on the sample dataset
 * and writes a Markdown report to download/.
 */
import { runDetective } from "./agents/detective.js";
import { runQA } from "./agents/qa.js";
import { runPatcher } from "./agents/patcher.js";
import { makeInitialState, runGraph, type NodeName } from "./graph/engine.js";
import type { BugCase, EngineState } from "./types/engine.js";
import { SAMPLE_CASES } from "../datasets/sample_cases.js";
import { ensureDir, nowIso, writeFile } from "./utils.js";

const DOWNLOAD_DIR = "/home/z/my-project/download";
const LOGS_DIR = "/home/z/my-project/scripts/self-healing-engine/logs";

/** Pick one case for a focused single-case run. */
async function runSingleCase(case_: BugCase): Promise<EngineState> {
  const workDir = `${LOGS_DIR}/${case_.id}_${Date.now()}`;
  const state = makeInitialState(case_, workDir);

  console.log("\n" + "=".repeat(72));
  console.log(`Case: ${case_.id} — ${case_.description}`);
  console.log("=".repeat(72));

  const finalState = await runGraph(state, {
    maxIterations: 12,
    onStep: (s, node) => {
      const last = s.trail[s.trail.length - 1];
      const tag =
        node === "done" ? "✓ DONE" :
        node === "fail" ? "✗ FAILED" :
        `[${node}]`;
      console.log(`  ${tag} ${last?.summary ?? ""}`);
    },
  });

  console.log(
    finalState.done
      ? `\n✓ FIXED. Patch summary: ${finalState.patch?.summary}`
      : `\n✗ COULD NOT FIX after ${finalState.hypothesisCursor + 1} hypotheses.`
  );
  return finalState;
}

/** Render a single case's reasoning trail + final patch as Markdown. */
function renderCaseReport(state: EngineState): string {
  const c = state.case;
  const lines: string[] = [];
  lines.push(`## Case \`${c.id}\` — ${c.description}`);
  lines.push("");
  lines.push(`**Status:** ${state.done ? "✅ FIXED" : "❌ FAILED"}`);
  lines.push(`**Hypotheses tried:** ${state.hypothesisCursor + (state.done ? 1 : 0)} / ${state.hypotheses.length}`);
  lines.push(`**Iterations:** ${state.trail.length}`);
  lines.push("");

  lines.push("### Symptom");
  lines.push("```");
  lines.push(c.symptom);
  lines.push("```");
  lines.push("");

  lines.push("### Buggy code");
  lines.push("```python");
  lines.push(c.buggyCode.trim());
  lines.push("```");
  lines.push("");

  if (state.hypotheses.length > 0) {
    lines.push("### Hypotheses (ranked)");
    for (const h of state.hypotheses) {
      const marker = h.id === state.currentHypothesisId && state.done ? " ⭐ ACCEPTED" : "";
      lines.push(`- **${h.title}** — confidence ${(h.confidence * 100).toFixed(0)}%${marker}`);
      lines.push(`  - ${h.reasoning}`);
      lines.push(`  - Proposed fix: ${h.proposedFix}`);
    }
    lines.push("");
  }

  if (state.patch) {
    lines.push("### Final patch");
    lines.push(`**Summary:** ${state.patch.summary}`);
    lines.push("");
    lines.push(`**Reasoning:** ${state.patch.reasoning}`);
    lines.push("");
    lines.push("```python");
    lines.push(state.patch.newContent.trim());
    lines.push("```");
    lines.push("");
  }

  lines.push("### Reasoning trail");
  for (const step of state.trail) {
    const icon =
      step.agent === "detective" ? "🔍" :
      step.agent === "qa" ? "🧪" :
      step.agent === "patcher" ? "🔧" :
      "📍";
    lines.push(`- ${icon} **[${step.agent}]** ${step.timestamp} — ${step.summary}`);
  }
  lines.push("");

  return lines.join("\n");
}

/** Run all cases in the dataset and write a single combined report. */
async function main() {
  await ensureDir(DOWNLOAD_DIR);
  await ensureDir(LOGS_DIR);

  console.log(`\n🧠 Self-Healing Code Reasoning Engine — PoC`);
  console.log(`📦 Dataset: ${SAMPLE_CASES.length} cases`);
  console.log(`📝 Logs: ${LOGS_DIR}`);
  console.log(`📄 Report: ${DOWNLOAD_DIR}/self_healing_report.md`);

  const reports: string[] = [];
  const summary: { id: string; status: string; hypothesesTried: number }[] = [];

  for (const case_ of SAMPLE_CASES) {
    const state = await runSingleCase(case_);
    reports.push(renderCaseReport(state));
    summary.push({
      id: case_.id,
      status: state.done ? "FIXED" : "FAILED",
      hypothesesTried: state.hypothesisCursor + (state.done ? 1 : 0),
    });
  }

  const fixedCount = summary.filter((s) => s.status === "FIXED").length;
  const header = [
    "# Self-Healing Code Reasoning Engine — PoC Report",
    "",
    `**Generated:** ${nowIso()}`,
    `**Dataset size:** ${SAMPLE_CASES.length}`,
    `**Fixed:** ${fixedCount} / ${SAMPLE_CASES.length}`,
    "",
    "## Summary",
    "",
    "| Case | Status | Hypotheses tried |",
    "|------|--------|------------------|",
    ...summary.map((s) => `| \`${s.id}\` | ${s.status === "FIXED" ? "✅ FIXED" : "❌ FAILED"} | ${s.hypothesesTried} |`),
    "",
    "---",
    "",
  ].join("\n");

  const reportPath = `${DOWNLOAD_DIR}/self_healing_report.md`;
  await writeFile(reportPath, header + reports.join("\n---\n\n"));

  console.log(`\n📊 Final score: ${fixedCount} / ${SAMPLE_CASES.length} cases fixed.`);
  console.log(`📄 Full report: ${reportPath}`);

  // Also expose the agents individually for unit testing / inspection.
  return { runDetective, runQA, runPatcher, runGraph };
}

main().catch((err) => {
  console.error("Fatal error in demo run:", err);
  process.exit(1);
});
