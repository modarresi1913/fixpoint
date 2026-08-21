/**
 * Preference Dataset Builder
 * ==========================
 *
 * Converts a list of TraceExamples into DPO-style preference pairs.
 *
 * Two pairing strategies:
 *
 *   1. WITHIN-CASE pairing (when a trace has ≥2 hypotheses).
 *      Pair the highest-reward hypothesis ("chosen") with the
 *      lowest-reward one ("rejected") from the SAME case. This is
 *      the cleanest signal — same bug, same symptom, the Detective
 *      itself ranked them differently.
 *
 *   2. CROSS-CASE pairing (when a trace has only 1 hypothesis, which
 *      is what our PoC scale run produced).
 *      Pair a hypothesis from a "fixed" case (chosen) with a
 *      hypothesis from a "failed/no_patch" case (rejected). The
 *      prompt is then a *generic* "given a bug, generate a hypothesis"
 *      prompt, and the model learns "hypotheses shaped like X are
 *      better than hypotheses shaped like Y".
 *
 * Both strategies emit pairs with a `margin` field; consumers can
 * filter low-margin pairs to keep only high-signal training examples.
 */
import type { PreferencePair, TraceExample } from "./types.js";

function buildPrompt(t: TraceExample): string {
  return (
    `## Specification\nA Python function in a real-world codebase.\n\n` +
    `## Buggy function source\n\`\`\`python\n${t.buggyCode}\n\`\`\`\n\n` +
    `## Symptom\n${t.symptom}\n\n` +
    `Generate 3 ranked hypotheses about the root cause.`
  );
}

/**
 * Within-case pairing. Returns one pair per trace that has ≥2
 * hypotheses with distinct rewards.
 */
function withinCasePairs(traces: TraceExample[]): PreferencePair[] {
  const pairs: PreferencePair[] = [];
  for (const t of traces) {
    if (t.hypotheses.length < 2) continue;
    const sorted = [...t.hypotheses].sort((a, b) => b.reward - a.reward);
    const chosen = sorted[0];
    const rejected = sorted[sorted.length - 1];
    if (chosen.reward === rejected.reward) continue;
    const prompt = buildPrompt(t);
    pairs.push({
      prompt,
      chosen: formatHypothesis(chosen),
      rejected: formatHypothesis(rejected),
      chosenReward: chosen.reward,
      rejectedReward: rejected.reward,
      margin: chosen.reward - rejected.reward,
      caseId: t.caseId,
    });
  }
  return pairs;
}

/**
 * Cross-case pairing. For each "positive" trace (fixed/partial or
 * qa_exposed_bug), pair it with a "negative" trace (failed/no_patch
 * without qa_exposed_bug). Returns up to N pairs.
 */
function crossCasePairs(
  traces: TraceExample[],
  maxPairs: number = 50
): PreferencePair[] {
  const positives = traces.filter(
    (t) =>
      t.finalStatus === "fixed" ||
      t.finalStatus === "partial" ||
      t.hypotheses.some((h) => h.qaExposedBug === true)
  );
  const negatives = traces.filter(
    (t) =>
      (t.finalStatus === "failed" || t.finalStatus === "no_patch") &&
      !t.hypotheses.some((h) => h.qaExposedBug === true)
  );

  const pairs: PreferencePair[] = [];
  for (const pos of positives) {
    if (pairs.length >= maxPairs) break;
    const posHyp = pos.hypotheses[0]; // top hypothesis
    if (!posHyp) continue;
    for (const neg of negatives) {
      if (pairs.length >= maxPairs) break;
      const negHyp = neg.hypotheses[0];
      if (!negHyp) continue;
      if (posHyp.reward <= negHyp.reward) continue;
      // We use the POSITIVE trace's prompt as the shared prompt —
      // the model learns "for this kind of bug, prefer hypotheses
      // shaped like posHyp, not negHyp".
      pairs.push({
        prompt: buildPrompt(pos),
        chosen: formatHypothesis(posHyp),
        rejected: formatHypothesis(negHyp),
        chosenReward: posHyp.reward,
        rejectedReward: negHyp.reward,
        margin: posHyp.reward - negHyp.reward,
        caseId: `${pos.caseId}__vs__${neg.caseId}`,
      });
    }
  }
  return pairs;
}

function formatHypothesis(h: {
  title: string;
  reasoning: string;
  proposedFix: string;
}): string {
  return (
    `Hypothesis: ${h.title}\n` +
    `Reasoning: ${h.reasoning}\n` +
    `Proposed fix: ${h.proposedFix}`
  );
}

export interface PreferenceDataset {
  pairs: PreferencePair[];
  withinCaseCount: number;
  crossCaseCount: number;
  /** Pairs with margin >= 0.2 (high signal). */
  highSignalCount: number;
  /** Average margin. */
  avgMargin: number;
}

export function buildPreferenceDataset(
  traces: TraceExample[],
  opts: { maxCrossCasePairs?: number } = {}
): PreferenceDataset {
  const within = withinCasePairs(traces);
  const cross = crossCasePairs(traces, opts.maxCrossCasePairs ?? 50);
  const pairs = [...within, ...cross];
  const highSignal = pairs.filter((p) => p.margin >= 0.2);
  const avgMargin =
    pairs.length === 0
      ? 0
      : pairs.reduce((s, p) => s + p.margin, 0) / pairs.length;
  return {
    pairs,
    withinCaseCount: within.length,
    crossCaseCount: cross.length,
    highSignalCount: highSignal.length,
    avgMargin,
  };
}
