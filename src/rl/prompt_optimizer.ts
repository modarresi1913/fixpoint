/**
 * Prompt Optimizer — the inference-time integration point.
 *
 * This is where the RL signal actually feeds back into the Detective.
 * At inference time, when the Detective is about to generate
 * hypotheses for a new bug, we:
 *
 *   1. Retrieve the top-K most similar past traces (by buggy-code
 *      similarity — we use a simple Jaccard-on-tokens proxy for PoC).
 *   2. From each retrieved trace, take the hypothesis with the
 *      highest reward.
 *   3. Inject those high-reward hypotheses into the Detective's
 *      prompt as few-shot examples ("Here are hypotheses that worked
 *      well on similar bugs in the past").
 *
 * This is a *retrieval-augmented* approach rather than fine-tuning.
 * It's the cheapest way to feed the reward signal back in without a
 * GPU, and it has the nice property that the Detective can see WHY
 * a past hypothesis was good (the bug context is right there).
 *
 * In production, this would be replaced by:
 *   - a fine-tuned Detective (LoRA on the preference dataset), OR
 *   - a learned retriever (dense embeddings instead of Jaccard).
 */
import type { TraceExample } from "./types.js";

/**
 * Tokenise a code string for similarity comparison.
 * We use a very simple bag-of-tokens: split on non-word chars,
 * lowercase, drop stopwords + single-char tokens.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "dare",
  "ought", "used", "to", "of", "in", "for", "on", "with", "at", "by",
  "from", "as", "into", "through", "during", "before", "after", "above",
  "below", "between", "under", "again", "further", "then", "once", "and",
  "but", "or", "if", "while", "about", "against", "between", "into",
  "self", "none", "true", "false", "return",
]);

function tokenise(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export interface RetrievedExample {
  trace: TraceExample;
  similarity: number;
  /** The hypothesis we're injecting (highest-reward from this trace). */
  hypothesisTitle: string;
  hypothesisReward: number;
}

/**
 * Retrieve the top-K most similar past traces for a new bug.
 */
export function retrieveSimilarTraces(
  newBuggyCode: string,
  corpus: TraceExample[],
  k: number = 3
): RetrievedExample[] {
  const queryTokens = tokenise(newBuggyCode);
  const scored = corpus
    .map((t) => {
      const traceTokens = tokenise(t.buggyCode);
      const sim = jaccard(queryTokens, traceTokens);
      // Pick the highest-reward hypothesis from this trace.
      const best = [...t.hypotheses].sort((a, b) => b.reward - a.reward)[0];
      return {
        trace: t,
        similarity: sim,
        hypothesisTitle: best?.title || "",
        hypothesisReward: best?.reward || 0,
      };
    })
    .filter((r) => r.similarity > 0 && r.hypothesisTitle)
    .sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k);
}

/**
 * Build the few-shot examples block to inject into the Detective's
 * prompt. Each example shows: a bug, the hypothesis that worked,
 * and why it worked (the reward components).
 */
export function buildFewShotBlock(retrieved: RetrievedExample[]): string {
  if (retrieved.length === 0) {
    return "";
  }
  const lines: string[] = [
    "## Reference: hypotheses that worked well on similar past bugs",
    "",
    "Use these as inspiration for the *shape* of a good hypothesis —",
    "specific, localised, and actionable. Do NOT copy them verbatim.",
    "",
  ];
  for (let i = 0; i < retrieved.length; i++) {
    const r = retrieved[i];
    lines.push(`### Example ${i + 1} (similarity: ${(r.similarity * 100).toFixed(0)}%, reward: ${r.hypothesisReward.toFixed(2)})`);
    lines.push(`Past bug: ${r.trace.caseId} (${r.trace.repo})`);
    lines.push(`Winning hypothesis: ${r.hypothesisTitle}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * The full integration: given a new bug and the corpus, return the
 * augmented prompt prefix the Detective should see.
 *
 * In practice, the Detective's existing system prompt stays the same;
 * we just prepend this block to the USER prompt.
 */
export function buildAugmentedPrompt(
  newBuggyCode: string,
  newSymptom: string,
  corpus: TraceExample[],
  opts: { k?: number } = {}
): string {
  const retrieved = retrieveSimilarTraces(newBuggyCode, corpus, opts.k ?? 3);
  const fewShot = buildFewShotBlock(retrieved);
  return (
    (fewShot ? fewShot + "\n---\n\n" : "") +
    `## Buggy function source\n\`\`\`python\n${newBuggyCode}\n\`\`\`\n\n` +
    `## Symptom\n${newSymptom}\n\n` +
    `Generate 3 ranked hypotheses now.`
  );
}
