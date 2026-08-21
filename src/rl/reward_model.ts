/**
 * Feature Engineering + Reward Model
 * ==================================
 *
 * The reward model takes a hypothesis (its text + the Detective's
 * confidence + its rank) and predicts P(this hypothesis leads to a
 * successful fix).
 *
 * We use logistic regression on a small set of engineered features.
 * This is a PoC baseline — a production version would use a
 * transformer-based reward model trained on the preference pairs.
 *
 * Features (all normalised to roughly [0, 1]):
 *   - confidence:        Detective's stated confidence, 0..1.
 *   - rankScore:         1/rank (top=1.0, second=0.5, third=0.33).
 *   - titleLength:       normalised title length (chars / 100).
 *   - mentionsSpecificLocation: 1 if the title mentions a line number,
 *                              variable name, or function name; 0 otherwise.
 *   - isSurgical:        1 if proposed fix is under 80 words.
 *   - isHedged:          1 if title contains hedge words.
 *
 * Training: gradient descent on the logistic loss, with the target
 * being `wasWinning` (1 if this hypothesis was the one that fixed
 * the bug, 0 otherwise).
 */
import type {
  HypothesisFeatures,
  HypothesisOutcome,
  TraceExample,
} from "./types.js";

const HEDGE_WORDS = [
  "maybe",
  "might",
  "could be",
  "possibly",
  "perhaps",
  "i think",
  "unclear",
  "not sure",
];

const SPECIFIC_PATTERNS = [
  /\bline\s+\d+/i,
  /\b\d+\s*[-:]\s*\d+\b/, // line ranges like 12-15
  /\bdef\s+\w+/i, // function name mention
  /\bclass\s+\w+/i, // class name mention
  /\b\w+\(\)/, // method call mention
  /\bvariable\s+\w+/i,
  /\b\w+\s*=/, // assignment mention
];

export function extractFeatures(
  h: HypothesisOutcome,
  wasWinning: boolean
): HypothesisFeatures {
  const titleLower = h.title.toLowerCase();
  const reasoningLower = (h.reasoning || "").toLowerCase();
  const proposedFixLower = (h.proposedFix || "").toLowerCase();
  const allText = `${h.title} ${h.reasoning} ${h.proposedFix}`.toLowerCase();

  const mentionsSpecificLocation = SPECIFIC_PATTERNS.some((p) =>
    p.test(h.title + " " + h.proposedFix)
  );

  const fixWordCount = (h.proposedFix || "").split(/\s+/).length;
  const isSurgical = fixWordCount > 0 && fixWordCount <= 80;

  const isHedged = HEDGE_WORDS.some((w) => allText.includes(w));

  return {
    confidence: clamp(h.confidence, 0, 1),
    rankScore: 1 / h.rank,
    titleLength: Math.min(1, h.title.length / 100),
    mentionsSpecificLocation,
    isSurgical,
    isHedged,
    reward: h.reward,
    wasWinning,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Convert features to a numeric vector for the logistic model. */
export function featuresToVector(f: HypothesisFeatures): number[] {
  return [
    f.confidence,
    f.rankScore,
    f.titleLength,
    f.mentionsSpecificLocation ? 1 : 0,
    f.isSurgical ? 1 : 0,
    f.isHedged ? 1 : 0,
    // bias term is added by the model itself
  ];
}

export const FEATURE_NAMES = [
  "confidence",
  "rankScore",
  "titleLength",
  "mentionsSpecificLocation",
  "isSurgical",
  "isHedged",
];

/**
 * A simple logistic-regression reward model.
 *
 * Trained with gradient descent on (features, wasWinning) pairs.
 * The output is interpreted as P(hypothesis leads to a fix).
 */
export class LogisticRewardModel {
  private weights: number[];
  private bias: number;
  private learningRate: number;
  private iterations: number;
  public trainingLoss: number[] = [];

  constructor(opts: { learningRate?: number; iterations?: number } = {}) {
    this.weights = new Array(FEATURE_NAMES.length).fill(0);
    this.bias = 0;
    this.learningRate = opts.learningRate ?? 0.1;
    this.iterations = opts.iterations ?? 500;
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
  }

  predict(features: HypothesisFeatures): number {
    const v = featuresToVector(features);
    let z = this.bias;
    for (let i = 0; i < v.length; i++) {
      z += this.weights[i] * v[i];
    }
    return this.sigmoid(z);
  }

  /**
   * Train on a list of (features, label) pairs.
   * label = 1 if this hypothesis was the one that fixed the bug.
   */
  train(samples: { features: HypothesisFeatures; label: number }[]): void {
    this.trainingLoss = [];
    for (let iter = 0; iter < this.iterations; iter++) {
      let totalLoss = 0;
      const gradW = new Array(this.weights.length).fill(0);
      let gradB = 0;

      for (const { features, label } of samples) {
        const v = featuresToVector(features);
        const pred = this.predict(features);
        const err = pred - label;
        // Binary cross-entropy loss
        totalLoss +=
          -label * Math.log(pred + 1e-9) - (1 - label) * Math.log(1 - pred + 1e-9);
        // Gradients
        for (let i = 0; i < v.length; i++) {
          gradW[i] += err * v[i];
        }
        gradB += err;
      }

      const n = samples.length;
      for (let i = 0; i < this.weights.length; i++) {
        this.weights[i] -= (this.learningRate * gradW[i]) / n;
      }
      this.bias -= (this.learningRate * gradB) / n;

      this.trainingLoss.push(totalLoss / n);

      // Early stopping if loss converges.
      if (
        iter > 20 &&
        Math.abs(this.trainingLoss[iter - 1] - this.trainingLoss[iter]) < 1e-6
      ) {
        break;
      }
    }
  }

  /** Get the learned weights, for inspection / reporting. */
  getWeights(): { feature: string; weight: number }[] {
    return FEATURE_NAMES.map((f, i) => ({
      feature: f,
      weight: this.weights[i],
    }));
  }

  getBias(): number {
    return this.bias;
  }
}

/**
 * Build the training set from a trace corpus.
 * Each hypothesis becomes one sample; label = 1 if it was the
 * hypothesis that led to the fix (judge_verdict == "equivalent").
 */
export function buildTrainingSet(
  traces: TraceExample[]
): { features: HypothesisFeatures; label: number; caseId: string }[] {
  const samples: { features: HypothesisFeatures; label: number; caseId: string }[] = [];
  for (const t of traces) {
    for (const h of t.hypotheses) {
      const wasWinning = h.judgeVerdict === "equivalent" || h.judgeVerdict === "partial";
      samples.push({
        features: extractFeatures(h, wasWinning),
        label: wasWinning ? 1 : 0,
        caseId: t.caseId,
      });
    }
  }
  return samples;
}
