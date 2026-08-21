/**
 * Detective Agent
 *
 * Input : a BugCase (buggy code + symptom + specification).
 * Output: a ranked list of 3 hypotheses, each with a proposed fix.
 *
 * Strategy: we use a single LLM call with a Tree-of-Thoughts-style prompt
 * — ask the model to produce 3 distinct candidate explanations and rank them
 * by likelihood. Cheaper than running 3 separate prompts and lets the model
 * contrast hypotheses against each other.
 */
import { askLLMJson } from "../llm.js";
import type { BugCase, Hypothesis, ReasoningStep } from "../types/engine.js";
import { makeId, nowIso } from "../utils.js";

const SYSTEM_PROMPT = `You are the Detective Agent in a self-healing code pipeline.

Your job: given a piece of buggy source code, a symptom (error message or failing test), and a short specification of what the code is supposed to do, you must:

1. Read the code carefully and identify every place that *could* be the root cause.
2. Generate exactly 3 DISTINCT hypotheses. They must be genuinely different explanations, not 3 paraphrases of the same idea. If the obvious bug is in line 5, your second hypothesis should consider a less obvious cause (e.g. an upstream data issue, an off-by-one elsewhere, a wrong default value).
3. For each hypothesis, write a concrete proposed fix in plain English. The Patcher Agent will turn your English into actual code, so be precise: "replace X with Y on line N", "add a check for None before calling .split()", etc.
4. Rank the 3 hypotheses by your confidence. Put the most likely first.

Respond with JSON in EXACTLY this shape:
{
  "hypotheses": [
    {
      "title": "short title, <= 12 words",
      "reasoning": "2-4 sentences explaining why this matches the symptom",
      "suspectedLocation": { "file": "main.py", "startLine": 1, "endLine": 999 },
      "proposedFix": "precise English description of the fix",
      "confidence": 0.0
    }
  ]
}

Rules:
- confidence is a float between 0 and 1. The three values should sum to roughly 1.0 (a probability distribution over your hypotheses).
- The first hypothesis must have the highest confidence.
- Do NOT propose generic advice like "improve error handling". Every proposedFix must be a concrete, localised change.
- Do NOT include markdown fences. Raw JSON only.`;

interface DetectiveResponse {
  hypotheses: Array<
    Omit<Hypothesis, "id"> & { id?: string }
  >;
}

export async function runDetective(case_: BugCase): Promise<{
  hypotheses: Hypothesis[];
  step: ReasoningStep;
}> {
  const userPrompt = `## Specification
${case_.specification}

## Buggy source code (file: main.py)
\`\`\`python
${case_.buggyCode}
\`\`\`

## Symptom (what went wrong)
${case_.symptom}

## Description
${case_.description}

Produce your 3 ranked hypotheses now.`;

  const parsed = await askLLMJson<DetectiveResponse>(
    SYSTEM_PROMPT,
    userPrompt,
    { thinking: true }
  );

  if (!parsed.hypotheses || parsed.hypotheses.length === 0) {
    throw new Error("Detective returned no hypotheses");
  }

  // Attach ids and clamp confidence.
  const totalConf = parsed.hypotheses.reduce(
    (s, h) => s + (h.confidence || 0),
    0
  );
  const hypotheses: Hypothesis[] = parsed.hypotheses.map((h, i) => ({
    id: makeId("hyp"),
    title: h.title,
    reasoning: h.reasoning,
    suspectedLocation: h.suspectedLocation,
    proposedFix: h.proposedFix,
    confidence: totalConf > 0 ? (h.confidence || 0) / totalConf : 1 / parsed.hypotheses.length,
  }));

  // Sort by confidence desc (defensive — prompt already asks for this).
  hypotheses.sort((a, b) => b.confidence - a.confidence);

  const step: ReasoningStep = {
    agent: "detective",
    timestamp: nowIso(),
    summary: `Generated ${hypotheses.length} hypotheses. Top: "${hypotheses[0].title}" (${(hypotheses[0].confidence * 100).toFixed(0)}%)`,
    details: hypotheses.map((h) => ({
      id: h.id,
      title: h.title,
      confidence: Number(h.confidence.toFixed(3)),
    })),
  };

  return { hypotheses, step };
}
