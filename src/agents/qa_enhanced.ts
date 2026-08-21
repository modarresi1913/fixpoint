/**
 * Enhanced QA Agent — handles real-world code from SWE-bench.
 *
 * Key change vs the toy version: the QA Agent now writes tests that
 * MOCK external dependencies instead of trying to import them. This
 * lets us run real verification against real code from Django/Astropy
 * without needing a full Docker container with all deps installed.
 *
 * The QA Agent receives:
 *   - the full buggy function source (not just a snippet);
 *   - a list of external names the function references (we extract
 *     these automatically — see extractExternalDeps);
 *   - instructions to write a pytest file that uses unittest.mock
 *     to stub those names, then exercises the buggy function and
 *     asserts it should fail (because of the bug).
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

1. Defines the function under test INLINE in the test file (pasted from the buggy code).
2. MOCKS every external name the function references that isn't a Python builtin. Use \`from unittest.mock import MagicMock, patch\` for this.
3. Targets EXACTLY the behaviour the hypothesis is about.
4. Should FAIL against the current buggy code (the test exposes the bug).
5. Will PASS once the detective's proposed fix is applied.

Output JSON in EXACTLY this shape:
{
  "testFile": "import pytest\\nfrom unittest.mock import MagicMock, patch\\n\\ndef buggy_function(...):\\n    ...\\n\\ndef test_...():\\n    ...",
  "rationale": "1-2 sentences on why this test exposes the bug."
}

CRITICAL RULES:
- The testFile MUST include the FULL buggy function definition inline (copy-pasted), so the test is self-contained.
- Every name from outside the function (e.g. \`frame_transform_graph\`, \`self._sky_coord_frame\`, imported classes) MUST be mocked.
- For class methods: define a minimal stub class with just the method under test, and use \`self\` as a MagicMock instance when calling it.
- Use only the standard library + pytest + unittest.mock. NO third-party imports.
- Use plain \`assert\` statements. Use \`pytest.raises\` only if the hypothesis is specifically about an exception.
- Do NOT include markdown fences. The "testFile" field is raw Python source as a JSON string.
- Keep it short: ideally 1-3 test functions, < 60 lines total.`;

interface QAResponse {
  testFile: string;
  rationale: string;
}

export interface QARunOutput {
  testResult: TestResult;
  runDir: string;
  rationale: string;
}

export async function runQAEnhanced(
  case_: BugCase,
  hypothesis: Hypothesis,
  workDir: string,
  attempt: number
): Promise<QARunOutput> {
  const userPrompt = `## Specification
${case_.specification}

## Buggy function source (full source — paste this into the test file)
\`\`\`python
${case_.buggyCode}
\`\`\`

## Symptom
${case_.symptom}

## Detective's hypothesis to verify
Title: ${hypothesis.title}
Reasoning: ${hypothesis.reasoning}
Proposed fix (English): ${hypothesis.proposedFix}

Write the pytest test file now. Remember: define the buggy function INLINE in the test file, mock every external name, and make the test FAIL on the buggy code.`;

  const response = await askLLMJson<QAResponse>(SYSTEM_PROMPT, userPrompt, {
    thinking: true,
  });

  // Run the test against the BUGGY code. We want it to FAIL.
  const sandboxInput: SandboxRunInput = {
    codeFile: case_.buggyCode,
    testFile: response.testFile,
    timeoutMs: 15_000,
  };
  const run = await runPythonTests(sandboxInput);

  const runDir = `${workDir}/qa_h${hypothesis.id.slice(-4)}_a${attempt}`;
  await persistSandboxRun(run, sandboxInput, runDir);

  const counts = parsePytestCounts(run.stdout);
  // "passed" here means "test correctly exposes the bug" (i.e. fails on buggy code).
  const passed =
    !run.timedOut &&
    run.exitCode !== 0 &&
    counts.failedCount > 0;

  // Distinguish "test failed because it caught the bug" vs "test failed because of import/syntax error".
  const isImportError = /ImportError|ModuleNotFoundError|cannot import name/i.test(run.stderr + run.stdout);
  const isSyntaxError = /SyntaxError|IndentationError/i.test(run.stderr + run.stdout);
  const exposesBug = passed && !isImportError && !isSyntaxError;

  const testResult: TestResult = {
    hypothesisId: hypothesis.id,
    testFile: response.testFile,
    stdout: run.stdout,
    stderr: run.stderr,
    passed: exposesBug,
    passedCount: counts.passedCount,
    failedCount: counts.failedCount,
    durationMs: run.durationMs,
  };

  await ensureDir(runDir);
  await writeFile(
    `${runDir}/rationale.md`,
    `# QA run for hypothesis ${hypothesis.id} (attempt ${attempt})\n\n` +
      `**Hypothesis:** ${hypothesis.title}\n\n` +
      `**Rationale:** ${response.rationale}\n\n` +
      `**Result:** ${
        exposesBug
          ? "test correctly fails on buggy code ✓"
          : isImportError
          ? "test failed due to ImportError (mocking incomplete) ✗"
          : isSyntaxError
          ? "test failed due to SyntaxError ✗"
          : "test does NOT expose the bug ✗"
      } (${counts.passedCount} passed / ${counts.failedCount} failed in ${run.durationMs}ms)\n\n` +
      `Generated at: ${nowIso()}\n`
  );

  return { testResult, runDir, rationale: response.rationale };
}
