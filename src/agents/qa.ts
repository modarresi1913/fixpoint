/**
 * QA Agent
 *
 * Input : a BugCase + a single Hypothesis.
 * Output: a TestResult — did the test we wrote confirm the hypothesis?
 *
 * The QA Agent's job is NOT to test the original bug (the bug is already
 * known to fail). Its job is to write a test that:
 *   (a) FAILS against the current buggy code (proving it actually targets
 *       the suspected bug — a sanity check);
 *   (b) will PASS once the Patcher applies the proposed fix.
 *
 * If the test PASSES against the buggy code, the hypothesis is wrong —
 * either the test is mis-targeted or the bug isn't where the Detective
 * thinks it is. The router will then move on to the next hypothesis.
 *
 * If the test FAILS against the buggy code, we record the failure output
 * so the Patcher can use it as the spec for the fix.
 */
import { askLLMJson } from "../llm.js";
import {
  parsePytestCounts,
  persistSandboxRun,
  runPythonTests,
  type SandboxRunInput,
} from "../sandbox/index.js";
import type { BugCase, Hypothesis, TestResult } from "../types/engine.js";
import { ensureDir, nowIso, writeFile } from "../utils.js";

const SYSTEM_PROMPT = `You are the QA Agent in a self-healing code pipeline.

A detective has produced a hypothesis about where a bug lives. Your job is to write a pytest test file that:

1. Imports functions/classes from main.py.
2. Targets EXACTLY the behaviour the hypothesis is about. Do not test unrelated behaviour.
3. Should FAIL against the current buggy code (the test exposes the bug).
4. Will PASS once the detective's proposed fix is applied.

Output JSON in EXACTLY this shape:
{
  "testFile": "import pytest\\nfrom main import ...\\n\\ndef test_...():\\n    ...",
  "rationale": "1-2 sentences on why this test exposes the bug."
}

Rules:
- Use only the standard library + pytest. Do not import third-party packages.
- The test file must be self-contained: only "from main import ..." is allowed as cross-file import.
- Use plain \`assert\` statements, not pytest.raises unless the hypothesis is specifically about an exception.
- Do not include markdown fences. The "testFile" field is raw Python source as a JSON string.
- Keep it short: ideally 1-3 test functions, < 30 lines total.`;

interface QAResponse {
  testFile: string;
  rationale: string;
}

export interface QARunOutput {
  testResult: TestResult;
  /** Path to the persisted sandbox run, for the report. */
  runDir: string;
  /** The rationale the QA agent wrote. */
  rationale: string;
}

export async function runQA(
  case_: BugCase,
  hypothesis: Hypothesis,
  workDir: string,
  attempt: number
): Promise<QARunOutput> {
  // 1. Ask the LLM for a test file.
  const userPrompt = `## Specification
${case_.specification}

## Buggy source code (main.py)
\`\`\`python
${case_.buggyCode}
\`\`\`

## Symptom
${case_.symptom}

## Detective's hypothesis to verify
Title: ${hypothesis.title}
Reasoning: ${hypothesis.reasoning}
Suspected location: ${hypothesis.suspectedLocation.file}:${hypothesis.suspectedLocation.startLine}-${hypothesis.suspectedLocation.endLine}
Proposed fix (English): ${hypothesis.proposedFix}

Write the pytest test file now.`;

  const response = await askLLMJson<QAResponse>(SYSTEM_PROMPT, userPrompt, {
    thinking: true,
  });

  // 2. Run the test against the BUGGY code first. We want it to FAIL.
  const sandboxInput: SandboxRunInput = {
    codeFile: case_.buggyCode,
    testFile: response.testFile,
    timeoutMs: 15_000,
  };
  const run = await runPythonTests(sandboxInput);

  // 3. Persist run for post-mortem.
  const runDir = `${workDir}/qa_h${hypothesis.id.slice(-4)}_a${attempt}`;
  await persistSandboxRun(run, sandboxInput, runDir);

  // 4. Parse the result.
  const counts = parsePytestCounts(run.stdout);
  const passed =
    // We want the test to expose the bug, i.e. FAIL against buggy code.
    !run.timedOut &&
    run.exitCode !== 0 &&
    counts.failedCount > 0 &&
    counts.passedCount >= 0;

  const testResult: TestResult = {
    hypothesisId: hypothesis.id,
    testFile: response.testFile,
    stdout: run.stdout,
    stderr: run.stderr,
    passed, // "passed" here means "test correctly exposes the bug"
    passedCount: counts.passedCount,
    failedCount: counts.failedCount,
    durationMs: run.durationMs,
  };

  // 5. Also write a marker file so the report can render this nicely.
  await ensureDir(runDir);
  await writeFile(
    `${runDir}/rationale.md`,
    `# QA run for hypothesis ${hypothesis.id} (attempt ${attempt})\n\n` +
      `**Hypothesis:** ${hypothesis.title}\n\n` +
      `**Rationale:** ${response.rationale}\n\n` +
      `**Result:** ${
        passed ? "test correctly fails on buggy code ✓" : "test does NOT expose the bug ✗"
      } (${counts.passedCount} passed / ${counts.failedCount} failed in ${run.durationMs}ms)\n\n` +
      `Generated at: ${nowIso()}\n`
  );

  return { testResult, runDir, rationale: response.rationale };
}
