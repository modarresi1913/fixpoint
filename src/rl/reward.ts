/**
 * Reward Function
 * ===============
 *
 * Maps a (hypothesis, case) pair to a scalar reward in [-1, +1].
 *
 * The function is intentionally simple and explainable — it's the
 * baseline that a trained reward model will eventually replace. The
 * goal here is to:
 *
 *   1. Define "what good looks like" in a way engineers can audit.
 *   2. Produce a signal that's correlated with actual fix success,
 *      so the preference dataset isn't noise.
 *   3. Be monotone: more reward components triggered ⇒ higher reward.
 *
 * Reward components
 * -----------------
 *   +1.0  judge_verdict == "equivalent"     (perfect fix)
 *   +0.5  judge_verdict == "partial"        (right area, imperfect)
 *   +0.3  patcher_verified                  (patched code passed QA test)
 *   +0.1  qa_exposed_bug                    (bug-exposing test, before patch)
 *   -0.2  judge_verdict == "wrong"          (confidently wrong)
 *   -0.3  patcher_verified == false         (patch broke things)
 *   -0.1 * (rank - 1)                       (prefer top-ranked hypotheses)
 *   -0.05 * (attempts_before - 0)           (prefer first-try wins)
 *
 * The final value is clamped to [-1, +1].
 */
import type { HypothesisOutcome } from "./types.js";

export interface RewardComponents {
  judgeEquivalent: number; // +1.0 or 0
  judgePartial: number; // +0.5 or 0
  patcherVerified: number; // +0.3 or 0
  qaExposedBug: number; // +0.1 or 0
  judgeWrong: number; // -0.2 or 0
  patcherFailed: number; // -0.3 or 0
  rankPenalty: number; // -0.1 * (rank - 1)
  attemptsPenalty: number; // -0.05 * attempts_before
  total: number; // sum, clamped
}

export interface RewardInput {
  rank: number; // 1-indexed
  attemptsBefore: number; // how many hypotheses were tried before this one
  qaExposedBug: boolean | null;
  patcherVerified: boolean | null;
  judgeVerdict: "equivalent" | "partial" | "wrong" | "no_fix" | null;
}

export function computeReward(input: RewardInput): RewardComponents {
  const c: RewardComponents = {
    judgeEquivalent: input.judgeVerdict === "equivalent" ? 1.0 : 0,
    judgePartial: input.judgeVerdict === "partial" ? 0.5 : 0,
    patcherVerified: input.patcherVerified === true ? 0.3 : 0,
    qaExposedBug: input.qaExposedBug === true ? 0.1 : 0,
    judgeWrong: input.judgeVerdict === "wrong" ? -0.2 : 0,
    patcherFailed: input.patcherVerified === false ? -0.3 : 0,
    rankPenalty: -0.1 * (input.rank - 1),
    attemptsPenalty: -0.05 * input.attemptsBefore,
    total: 0,
  };
  const sum =
    c.judgeEquivalent +
    c.judgePartial +
    c.patcherVerified +
    c.qaExposedBug +
    c.judgeWrong +
    c.patcherFailed +
    c.rankPenalty +
    c.attemptsPenalty;
  c.total = Math.max(-1, Math.min(1, sum));
  return c;
}

/** Convenience: compute reward and return only the scalar. */
export function rewardOf(input: RewardInput): number {
  return computeReward(input).total;
}

/**
 * Apply the reward function to every hypothesis in a trace.
 * Mutates the array in place AND returns it for chaining.
 */
export function annotateHypothesesWithRewards(
  hypotheses: Array<
    Omit<HypothesisOutcome, "reward"> & { reward?: number }
  >
): HypothesisOutcome[] {
  let attemptsBefore = 0;
  return hypotheses.map((h, idx) => {
    const rank = idx + 1;
    const components = computeReward({
      rank,
      attemptsBefore,
      qaExposedBug: h.qaExposedBug ?? null,
      patcherVerified: h.patcherVerified ?? null,
      judgeVerdict: h.judgeVerdict ?? null,
    });
    attemptsBefore += 1;
    return {
      ...h,
      reward: components.total,
    } as HypothesisOutcome;
  });
}

/**
 * Human-readable explanation of a reward — used in the report so a
 * reviewer can sanity-check the function.
 */
export function explainReward(input: RewardInput): string {
  const c = computeReward(input);
  const parts: string[] = [];
  if (c.judgeEquivalent) parts.push(`+1.0 judge=equivalent`);
  if (c.judgePartial) parts.push(`+0.5 judge=partial`);
  if (c.patcherVerified) parts.push(`+0.3 patcher_verified`);
  if (c.qaExposedBug) parts.push(`+0.1 qa_exposed_bug`);
  if (c.judgeWrong) parts.push(`-0.2 judge=wrong`);
  if (c.patcherFailed) parts.push(`-0.3 patcher_failed`);
  if (c.rankPenalty) parts.push(`${c.rankPenalty.toFixed(2)} rank_penalty`);
  if (c.attemptsPenalty)
    parts.push(`${c.attemptsPenalty.toFixed(2)} attempts_penalty`);
  return parts.length === 0
    ? `0.00 (no signal)`
    : `${parts.join(" + ")} = ${c.total.toFixed(2)}`;
}
