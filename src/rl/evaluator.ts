/**
 * Evaluator — does the reward signal actually correlate with success?
 *
 * We compute three correlation metrics:
 *
 *   1. Reward → wasWinning (point-biserial correlation).
 *      Does a higher hand-coded reward predict that the hypothesis
 *      was the one that fixed the bug?
 *
 *   2. Reward model pWin → wasWinning (same metric, but using the
 *      trained model's prediction instead of the hand-coded reward).
 *      This tells us whether the model learned anything beyond the
 *      hand-coded features.
 *
 *   3. Precision@1: of the cases where we had ≥2 hypotheses, how
 *      often does the highest-reward hypothesis match the one that
 *      actually won? This is the metric the Detective cares about.
 *
 * If (1) is high, our hand-coded reward is good.
 * If (2) > (1), the model found extra signal.
 * If (3) is high, the reward function ranks correctly.
 */
import type { TraceExample, HypothesisFeatures } from "./types.js";
import { LogisticRewardModel, buildTrainingSet, extractFeatures } from "./reward_model.js";
import type { CorpusStats } from "./trace_analyzer.js";

export interface EvalResult {
  /** Pearson correlation between hand-coded reward and wasWinning. */
  rewardCorrelation: number;
  /** Pearson correlation between model pWin and wasWinning. */
  modelCorrelation: number;
  /** Of traces with ≥2 hypotheses, % where top-reward = winner. */
  precisionAt1: number;
  /** Number of traces used in the precision@1 evaluation. */
  precisionAt1Traces: number;
  /** Trained model's weights, for inspection. */
  modelWeights: { feature: string; weight: number }[];
  modelBias: number;
  /** Final training loss. */
  finalLoss: number;
  /** Number of training samples. */
  trainingSamples: number;
  /** Positive samples (wasWinning=1). */
  positiveSamples: number;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

export function evaluateRewardSignal(traces: TraceExample[]): EvalResult {
  // Build training set.
  const samples = buildTrainingSet(traces);

  // Train model with leave-one-out cross-validation style — actually
  // for PoC we just train on all data and report in-sample fit. A real
  // evaluation would split train/test, but we don't have enough data.
  const model = new LogisticRewardModel({ learningRate: 0.1, iterations: 1000 });
  model.train(samples.map((s) => ({ features: s.features, label: s.label })));

  // Collect (reward, wasWinning) and (pWin, wasWinning) pairs.
  const rewards: number[] = [];
  const pWins: number[] = [];
  const labels: number[] = [];
  for (const s of samples) {
    rewards.push(s.features.reward);
    pWins.push(model.predict(s.features));
    labels.push(s.label);
  }

  // Precision@1: for traces with ≥2 hypotheses, did the highest-reward
  // one match the winner?
  let precisionHits = 0;
  let precisionTotal = 0;
  for (const t of traces) {
    if (t.hypotheses.length < 2) continue;
    precisionTotal++;
    const sorted = [...t.hypotheses].sort((a, b) => b.reward - a.reward);
    const top = sorted[0];
    if (
      (top.judgeVerdict === "equivalent" || top.judgeVerdict === "partial") &&
      labels[samples.findIndex((s) => s.caseId === t.caseId)] === 1
    ) {
      precisionHits++;
    }
    // Fallback: if no judge verdict, count "qa exposed bug" as the win signal.
    if (
      !t.hypotheses.some(
        (h) => h.judgeVerdict === "equivalent" || h.judgeVerdict === "partial"
      ) &&
      top.qaExposedBug === true &&
      t.hypotheses.some((h) => h.qaExposedBug === true)
    ) {
      // Did the top-reward hypothesis expose the bug?
      if (top.qaExposedBug === true) precisionHits++;
    }
  }

  return {
    rewardCorrelation: pearson(rewards, labels),
    modelCorrelation: pearson(pWins, labels),
    precisionAt1: precisionTotal === 0 ? 0 : precisionHits / precisionTotal,
    precisionAt1Traces: precisionTotal,
    modelWeights: model.getWeights(),
    modelBias: model.getBias(),
    finalLoss: model.trainingLoss[model.trainingLoss.length - 1] || 0,
    trainingSamples: samples.length,
    positiveSamples: samples.filter((s) => s.label === 1).length,
  };
}
