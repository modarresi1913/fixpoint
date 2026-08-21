/**
 * RL Pipeline Runner
 * ==================
 *
 * End-to-end: trace corpus -> reward annotation -> preference dataset ->
 * reward model training -> evaluation -> report.
 *
 * Also writes the preference dataset as JSON (DPO-trainer-consumable)
 * and dumps the trained reward model's weights for inspection.
 */
import { promises as fs } from "node:fs";
import {
  loadTraceCorpus,
  summariseCorpus,
  type CorpusStats,
} from "./trace_analyzer.js";
import { buildPreferenceDataset } from "./preference_dataset.js";
import { evaluateRewardSignal, type EvalResult } from "./evaluator.js";
import { buildAugmentedPrompt, retrieveSimilarTraces } from "./prompt_optimizer.js";
import { explainReward } from "./reward.js";
import type { TraceExample } from "./types.js";
import { ensureDir, nowIso, writeFile } from "../utils.js";

const DOWNLOAD_DIR = "/home/z/my-project/download";

function pct(n: number, d: number): string {
  return d === 0 ? "0%" : `${((n / d) * 100).toFixed(0)}%`;
}

function renderReport(
  traces: TraceExample[],
  stats: CorpusStats,
  evalResult: EvalResult,
  preferenceDataset: {
    pairs: any[];
    withinCaseCount: number;
    crossCaseCount: number;
    highSignalCount: number;
    avgMargin: number;
  },
  sampleAugmentedPrompt: string
): string {
  const lines: string[] = [];
  lines.push("# RL Layer -- PoC Report");
  lines.push("");
  lines.push(`**Generated:** ${nowIso()}`);
  lines.push(`**Corpus source:** logs/swebench_* + download/swebench_*_results.json`);
  lines.push("");
  lines.push("> This report shows the end-to-end RL pipeline: trace corpus -> reward annotation -> preference dataset -> reward model training -> evaluation. The pipeline runs entirely on the trace corpus we already collected from the closed-loop engine runs -- no new LLM calls are made.");
  lines.push("");

  // ---- Corpus stats ----
  lines.push("## 1. Trace Corpus");
  lines.push("");
  lines.push(`**Total traces:** ${stats.totalTraces}`);
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push(`| Traces with judge verdict | ${stats.tracesWithJudge} (${pct(stats.tracesWithJudge, stats.totalTraces)}) |`);
  lines.push(`| Fixed (judge=equivalent) | ${stats.tracesFixed} (${pct(stats.tracesFixed, stats.totalTraces)}) |`);
  lines.push(`| Partial | ${stats.tracesPartial} |`);
  lines.push(`| Failed | ${stats.tracesFailed} |`);
  lines.push(`| No patch produced | ${stats.tracesNoPatch} |`);
  lines.push(`| Errors | ${stats.tracesError} |`);
  lines.push(`| QA exposed the bug | ${stats.tracesWithQaExposed} |`);
  lines.push(`| Patcher verification passed | ${stats.tracesWithVerifierPassed} |`);
  lines.push("");
  lines.push("### Per-repo distribution");
  lines.push("");
  lines.push("| Repo | Traces |");
  lines.push("|------|--------|");
  for (const [repo, n] of Object.entries(stats.byRepo).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${repo} | ${n} |`);
  }
  lines.push("");
  lines.push("### Reward distribution (hand-coded reward function)");
  lines.push("");
  lines.push("| Bucket | Hypotheses |");
  lines.push("|--------|------------|");
  for (const b of stats.rewardHistogram) {
    lines.push(`| ${b.bucket} | ${b.count} |`);
  }
  lines.push("");

  // ---- Reward function ----
  lines.push("## 2. Reward Function");
  lines.push("");
  lines.push("Hand-coded reward in `[-1, +1]` based on closed-loop outcomes:");
  lines.push("");
  lines.push("```");
  lines.push("+1.0  judge_verdict == 'equivalent'    (perfect fix)");
  lines.push("+0.5  judge_verdict == 'partial'       (right area, imperfect)");
  lines.push("+0.3  patcher_verified                 (patched code passed QA test)");
  lines.push("+0.1  qa_exposed_bug                   (bug-exposing test, before patch)");
  lines.push("-0.2  judge_verdict == 'wrong'         (confidently wrong)");
  lines.push("-0.3  patcher_verified == false        (patch broke things)");
  lines.push("-0.1 * (rank - 1)                      (prefer top-ranked)");
  lines.push("-0.05 * (attempts_before)              (prefer first-try wins)");
  lines.push("```");
  lines.push("");

  // ---- Preference dataset ----
  lines.push("## 3. Preference Dataset (DPO-style)");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total pairs | ${preferenceDataset.pairs.length} |`);
  lines.push(`| Within-case pairs (>=2 hyps in same trace) | ${preferenceDataset.withinCaseCount} |`);
  lines.push(`| Cross-case pairs (pos trace vs neg trace) | ${preferenceDataset.crossCaseCount} |`);
  lines.push(`| High-signal pairs (margin >= 0.2) | ${preferenceDataset.highSignalCount} |`);
  lines.push(`| Average margin | ${preferenceDataset.avgMargin.toFixed(3)} |`);
  lines.push("");
  lines.push("Saved as `download/rl_preference_dataset.json` -- consumable by any DPO trainer.");
  lines.push("");

  // ---- Reward model ----
  lines.push("## 4. Reward Model (Logistic Regression Baseline)");
  lines.push("");
  lines.push("Trained on the corpus with binary cross-entropy loss. Label = 1 if the hypothesis was the one that fixed the bug.");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Training samples | ${evalResult.trainingSamples} |`);
  lines.push(`| Positive samples | ${evalResult.positiveSamples} |`);
  lines.push(`| Final loss | ${evalResult.finalLoss.toFixed(4)} |`);
  lines.push("");
  lines.push("### Learned feature weights");
  lines.push("");
  lines.push("| Feature | Weight | Interpretation |");
  lines.push("|---------|--------|----------------|");
  const interpretations: Record<string, string> = {
    confidence: "Detective's stated confidence",
    rankScore: "1/rank -- being top-ranked",
    titleLength: "Hypothesis title length (normalised)",
    mentionsSpecificLocation: "Title mentions a line/var/function name",
    isSurgical: "Proposed fix is < 80 words",
    isHedged: "Title contains hedge words (maybe, might, ...)",
  };
  for (const w of evalResult.modelWeights) {
    const sign = w.weight > 0 ? "+" : "";
    lines.push(
      `| ${w.feature} | ${sign}${w.weight.toFixed(4)} | ${interpretations[w.feature] || ""} |`
    );
  }
  lines.push(`| (bias) | ${evalResult.modelBias.toFixed(4)} | |`);
  lines.push("");

  // ---- Evaluation ----
  lines.push("## 5. Evaluation -- Does the Reward Signal Correlate with Success?");
  lines.push("");
  lines.push("| Metric | Value | What it means |");
  lines.push("|--------|-------|---------------|");
  lines.push(
    `| **Hand-coded reward -> wasWinning** | **${evalResult.rewardCorrelation.toFixed(3)}** | Pearson correlation. >0 = reward aligns with success. |`
  );
  lines.push(
    `| **Model pWin -> wasWinning** | **${evalResult.modelCorrelation.toFixed(3)}** | Trained model's prediction. Should be >= hand-coded reward. |`
  );
  lines.push(
    `| **Precision@1** | **${(evalResult.precisionAt1 * 100).toFixed(0)}%** (${evalResult.precisionAt1Traces} traces) | Of traces with >=2 hypotheses, how often the highest-reward one was the winner. |`
  );
  lines.push("");
  lines.push("> **Caveat:** with the current PoC corpus size, the evaluation is in-sample. A real evaluation would split train/test, but we don't have enough traces yet for a held-out set. The numbers below are directional, not statistical.");
  lines.push("");

  // ---- Sample trace ----
  if (traces.length > 0) {
    lines.push("## 6. Sample Trace (one example from the corpus)");
    lines.push("");
    const t = traces[0];
    lines.push(`**Case:** \`${t.caseId}\``);
    lines.push(`**Repo:** ${t.repo}`);
    lines.push(`**Function:** \`${t.functionName}()\``);
    lines.push(`**Final status:** ${t.finalStatus}`);
    lines.push("");
    lines.push("### Hypotheses and rewards");
    lines.push("");
    for (const h of t.hypotheses) {
      lines.push(`- **${h.title}**`);
      lines.push(`  - confidence: ${h.confidence.toFixed(2)}, rank: ${h.rank}`);
      lines.push(`  - QA exposed bug: ${h.qaExposedBug}, patcher verified: ${h.patcherVerified}, judge: ${h.judgeVerdict}`);
      lines.push(`  - reward: ${h.reward.toFixed(2)}`);
      lines.push("");
    }
  }

  // ---- Integration point ----
  lines.push("## 7. Integration Point -- Retrieval-Augmented Prompting");
  lines.push("");
  lines.push("At inference time, the Detective's prompt is augmented with high-reward hypotheses from similar past traces. This is the cheapest way to feed the reward signal back in without a GPU.");
  lines.push("");
  lines.push("### Sample augmented prompt (for the first corpus trace)");
  lines.push("");
  lines.push("```");
  lines.push(sampleAugmentedPrompt.slice(0, 2000));
  lines.push("```");
  lines.push("");

  // ---- Roadmap ----
  lines.push("## 8. Roadmap to Production RL");
  lines.push("");
  lines.push("1. **More traces.** The current corpus is too small for a held-out evaluation. The Docker sandbox fix (next on the roadmap) will let us run the closed loop on all 500 SWE-bench_Verified instances, growing the corpus 50×.");
  lines.push("2. **Train/test split.** Once we have >=100 traces, hold out 20% for evaluation and report the correlation metrics on the held-out set.");
  lines.push("3. **Replace logistic regression with a transformer reward model.** A small BERT/RoBERTa fine-tuned on the preference pairs will capture semantic features the hand-coded features miss.");
  lines.push("4. **DPO fine-tune the Detective.** Use the preference dataset to LoRA-fine-tune the underlying LLM. This is the 'Thiel's Secret' data moat -- every successful trace becomes a training example.");
  lines.push("5. **Online bandit over hypothesis strategies.** Once the reward model is reliable, use it as a bandit over different Detective prompting strategies (Tree-of-Thoughts vs. plain top-3 vs. counterfactual).");

  return lines.join("\n");
}

async function main() {
  await ensureDir(DOWNLOAD_DIR);

  console.log("Loading trace corpus...");
  const traces = await loadTraceCorpus();
  console.log(`Loaded ${traces.length} traces.`);

  if (traces.length === 0) {
    console.error("No traces found. Run the engine first.");
    process.exit(1);
  }

  console.log("Computing corpus stats...");
  const stats = summariseCorpus(traces);

  console.log("Building preference dataset...");
  const preferenceDataset = buildPreferenceDataset(traces, {
    maxCrossCasePairs: 50,
  });
  await writeFile(
    `${DOWNLOAD_DIR}/rl_preference_dataset.json`,
    JSON.stringify(
      {
        generatedAt: nowIso(),
        corpusSize: traces.length,
        ...preferenceDataset,
      },
      null,
      2
    )
  );
  console.log(
    `  -> ${preferenceDataset.pairs.length} pairs (${preferenceDataset.highSignalCount} high-signal).`
  );

  console.log("Training reward model...");
  const evalResult = evaluateRewardSignal(traces);
  console.log(
    `  -> reward correlation: ${evalResult.rewardCorrelation.toFixed(3)}`
  );
  console.log(
    `  -> model correlation:  ${evalResult.modelCorrelation.toFixed(3)}`
  );
  console.log(
    `  -> precision@1:        ${(evalResult.precisionAt1 * 100).toFixed(0)}%`
  );

  await writeFile(
    `${DOWNLOAD_DIR}/rl_reward_model.json`,
    JSON.stringify(
      {
        generatedAt: nowIso(),
        weights: evalResult.modelWeights,
        bias: evalResult.modelBias,
        finalLoss: evalResult.finalLoss,
        trainingSamples: evalResult.trainingSamples,
        positiveSamples: evalResult.positiveSamples,
        metrics: {
          rewardCorrelation: evalResult.rewardCorrelation,
          modelCorrelation: evalResult.modelCorrelation,
          precisionAt1: evalResult.precisionAt1,
          precisionAt1Traces: evalResult.precisionAt1Traces,
        },
      },
      null,
      2
    )
  );

  // Sample augmented prompt for the report.
  const sampleAugmented =
    traces.length > 0
      ? buildAugmentedPrompt(
          traces[0].buggyCode,
          traces[0].symptom,
          traces.slice(1)
        )
      : "";

  console.log("Rendering report...");
  const report = renderReport(
    traces,
    stats,
    evalResult,
    preferenceDataset,
    sampleAugmented
  );
  const reportPath = `${DOWNLOAD_DIR}/rl_layer_report.md`;
  await writeFile(reportPath, report);

  console.log("\n" + "═".repeat(60));
  console.log(`RL layer PoC complete.`);
  console.log(`  Traces:          ${traces.length}`);
  console.log(`  Preference pairs: ${preferenceDataset.pairs.length}`);
  console.log(`  Reward corr:     ${evalResult.rewardCorrelation.toFixed(3)}`);
  console.log(`  Model corr:      ${evalResult.modelCorrelation.toFixed(3)}`);
  console.log(`  Precision@1:     ${(evalResult.precisionAt1 * 100).toFixed(0)}%`);
  console.log(`  📄 Report:       ${reportPath}`);
  console.log(`  📊 Dataset:      ${DOWNLOAD_DIR}/rl_preference_dataset.json`);
  console.log(`  📊 Model:        ${DOWNLOAD_DIR}/rl_reward_model.json`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
