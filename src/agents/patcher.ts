/**
 * Patcher Agent
 *
 * Input : a BugCase + a confirmed Hypothesis (one whose QA test
 *         correctly fails on the buggy code) + the test file the QA wrote.
 * Output: a Patch — the full new content of main.py, plus a short
 *         human-readable summary and the reasoning behind the change.
 *
 * After producing the patch, the engine re-runs the QA test against the
 * patched code. If green, we're done. If red, the router can either ask
 * the patcher to try again or move on to the next hypothesis.
 *
 * Design choice: we ask for the FULL file content rather than a unified
 * diff. Diff generation by LLMs is notoriously unreliable (whitespace,
 * line-number drift). Full-file rewrite is wasteful for big files but
 * rock-solid for the PoC's small cases. A production version would switch
 * to tree-sitter-anchored edits.
 */
import { askLLMJson } from "../llm.js";
import {
  parsePytestCounts,
  persistSandboxRun,
  runPythonTests,
  type SandboxRunInput,
} from "../sandbox/index.js";
import type { BugCase, Hypothesis, Patch, TestResult } from "../types/engine.js";
import { ensureDir, writeFile } from "../utils.js";

const SYSTEM_PROMPT = `You are the Patcher Agent in a self-healing code pipeline.

A detective has identified the bug, and the QA agent has written a test that exposes it. Your job is to apply the smallest, most surgical fix that:
1. Makes the QA test pass.
2. Does not change unrelated behaviour.
3. Does not introduce syntax errors or new bugs.

Output JSON in EXACTLY this shape:
{
  "newContent": "...full new content of main.py as a string...",
  "summary": "one-line description of the change, e.g. 'Replaced < with <= in loop bound'",
  "reasoning": "2-3 sentences on why this fix is correct and minimal."
}

Rules:
- The "newContent" field must be the COMPLETE, runnable main.py — not a diff, not a fragment.
- Preserve every function signature, class, and import that is not directly implicated by the bug.
- Do not add comments like "# fixed" or "# TODO". The code must look like it was written correctly the first time.
- Do not include markdown fences around the code.
- If the hypothesis is wrong and you cannot see how to fix the bug, still produce your best attempt — the QA re-run will catch a bad patch.`;

interface PatcherResponse {
  newContent: string;
  summary: string;
  reasoning: string;
}

export interface PatcherRunOutput {
  patch: Patch;
  /** Result of re-running the QA test against the patched code. */
  verification: TestResult;
  /** Where the verification run was persisted. */
  runDir: string;
}

export async function runPatcher(
  case_: BugCase,
  hypothesis: Hypothesis,
  qaTestFile: string,
  workDir: string
): Promise<PatcherRunOutput> {
  const userPrompt = `## Specification
${case_.specification}

## Buggy source code (main.py)
\`\`\`python
${case_.buggyCode}
\`\`\`

## Symptom
${case_.symptom}

## Detective's hypothesis
Title: ${hypothesis.title}
Reasoning: ${hypothesis.reasoning}
Proposed fix (English): ${hypothesis.proposedFix}

## QA test that currently fails (test_main.py)
\`\`\`python
${qaTestFile}
\`\`\`

Apply the fix. Output the complete new main.py.`;

  const response = await askLLMJson<PatcherResponse>(
    SYSTEM_PROMPT,
    userPrompt,
    { thinking: true }
  );

  // Defensive: strip a stray ```python fence if the model added one despite instructions.
  const newContent = response.newContent
    .replace(/^\s*```python\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  const patch: Patch = {
    hypothesisId: hypothesis.id,
    newContent,
    summary: response.summary,
    reasoning: response.reasoning,
  };

  // Re-run the QA test against the patched code.
  const sandboxInput: SandboxRunInput = {
    codeFile: newContent,
    testFile: qaTestFile,
    timeoutMs: 15_000,
  };
  const run = await runPythonTests(sandboxInput);
  const counts = parsePytestCounts(run.stdout);

  const runDir = `${workDir}/patcher_h${hypothesis.id.slice(-4)}`;
  await persistSandboxRun(run, sandboxInput, runDir);

  const verification: TestResult = {
    hypothesisId: hypothesis.id,
    testFile: qaTestFile,
    stdout: run.stdout,
    stderr: run.stderr,
    passed:
      !run.timedOut &&
      run.exitCode === 0 &&
      counts.failedCount === 0 &&
      counts.passedCount > 0,
    passedCount: counts.passedCount,
    failedCount: counts.failedCount,
    durationMs: run.durationMs,
  };

  await ensureDir(runDir);
  await writeFile(
    `${runDir}/patch_summary.md`,
    `# Patch summary\n\n` +
      `**Hypothesis:** ${hypothesis.title}\n\n` +
      `**Summary:** ${response.summary}\n\n` +
      `**Reasoning:** ${response.reasoning}\n\n` +
      `**Verification:** ${verification.passed ? "PASS ✓" : "FAIL ✗"} ` +
      `(${verification.passedCount} passed / ${verification.failedCount} failed)\n`
  );

  return { patch, verification, runDir };
}
