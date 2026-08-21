/**
 * Shared types for the RL layer.
 *
 * A `TraceExample` is the structured representation of one closed-loop
 * run on one bug case. It's the unit the rest of the RL pipeline
 * operates on.
 */

/** Outcome of a single hypothesis attempt. */
export interface HypothesisOutcome {
  /** The hypothesis text the Detective produced. */
  title: string;
  reasoning: string;
  proposedFix: string;
  /** Detective's confidence, 0..1. */
  confidence: number;
  /** 1-indexed rank in the Detective's output (1 = top). */
  rank: number;
  /** Did the QA test fail on the buggy code (i.e. expose the bug)? */
  qaExposedBug: boolean | null;
  /** Did the patched code pass the QA test? */
  patcherVerified: boolean | null;
  /** LLM-as-judge verdict (only set for the hypothesis that reached the judge). */
  judgeVerdict: "equivalent" | "partial" | "wrong" | "no_fix" | null;
  /** Scalar reward computed by the reward function. */
  reward: number;
}

/** One full trace, parsed from a logs/swebench_* directory. */
export interface TraceExample {
  caseId: string;
  repo: string;
  filePath: string;
  functionName: string;
  /** The buggy code the Detective saw. */
  buggyCode: string;
  /** The symptom text the Detective saw. */
  symptom: string;
  /** Ground-truth fixed code (for evaluation only). */
  referenceFix: string;
  /** All hypotheses the Detective produced (ranked). */
  hypotheses: HypothesisOutcome[];
  /** Final status of the closed loop on this case. */
  finalStatus: "fixed" | "partial" | "failed" | "no_patch" | "error";
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Path to the original log directory, for debugging. */
  sourceLogDir: string;
}

/** A DPO-style preference pair, derived from a TraceExample. */
export interface PreferencePair {
  /** The original prompt the Detective received. */
  prompt: string;
  /** The hypothesis text that got the higher reward. */
  chosen: string;
  /** The hypothesis text that got the lower reward. */
  rejected: string;
  chosenReward: number;
  rejectedReward: number;
  /** Margin between chosen and rejected (used to filter low-signal pairs). */
  margin: number;
  caseId: string;
}

/** Engineered features for one hypothesis, used by the reward model. */
export interface HypothesisFeatures {
  /** Detective's normalised confidence, 0..1. */
  confidence: number;
  /** 1/rank, so top-ranked = 1.0, second = 0.5, third = 0.33. */
  rankScore: number;
  /** Title length (chars) — verbose hypotheses may be worse. */
  titleLength: number;
  /** Whether the proposed fix mentions a specific line/variable name. */
  mentionsSpecificLocation: boolean;
  /** Whether the proposed fix is "surgical" (under 80 words). */
  isSurgical: boolean;
  /** Whether the hypothesis title contains hedge words ("maybe", "might"). */
  isHedged: boolean;
  /** Reward label (target). */
  reward: number;
  /** Convenience: was this hypothesis ultimately the one that fixed the bug? */
  wasWinning: boolean;
}

/** Output of the reward model for one hypothesis. */
export interface RewardModelPrediction {
  /** Predicted P(this hypothesis leads to a successful fix), 0..1. */
  pWin: number;
  /** The engineered feature vector that produced this prediction. */
  features: HypothesisFeatures;
}
