/**
 * Shared types for the Self-Healing Code Reasoning Engine.
 *
 * The whole pipeline is built around a single mutable `EngineState` object
 * that flows through the graph nodes. Each agent reads from it, writes to it,
 * and the graph decides the next edge based on its content.
 */

/** A single candidate explanation produced by the Detective Agent. */
export interface Hypothesis {
  id: string;
  /** Short human-readable title, e.g. "Off-by-one in loop bound". */
  title: string;
  /** Detailed reasoning: why this hypothesis explains the symptom. */
  reasoning: string;
  /** Concrete file + line range the detective believes is at fault. */
  suspectedLocation: {
    file: string;
    startLine: number;
    endLine: number;
  };
  /** Proposed fix in plain English — the Patcher will turn this into code. */
  proposedFix: string;
  /** Score assigned by the QA Agent after running tests (0..1). */
  confidence: number;
}

/** Result of running one test file inside the sandbox. */
export interface TestResult {
  hypothesisId: string;
  /** The pytest-style test file the QA agent wrote. */
  testFile: string;
  /** Raw stdout from the test runner. */
  stdout: string;
  /** Raw stderr from the test runner. */
  stderr: string;
  /** True if every test in the file passed. */
  passed: boolean;
  /** Number of tests that passed / failed. */
  passedCount: number;
  failedCount: number;
  /** Wall-clock time in ms. */
  durationMs: number;
}

/** The fix the Patcher Agent proposes to apply. */
export interface Patch {
  hypothesisId: string;
  /** Full new content of the file after the patch (PoC: full-file rewrite). */
  newContent: string;
  /** Short diff-style summary for logging. */
  summary: string;
  /** Reasoning the patcher outputs alongside the code. */
  reasoning: string;
}

/** A bug case from the dataset. */
export interface BugCase {
  id: string;
  description: string;
  /** Original (buggy) source code, full file content. */
  buggyCode: string;
  /** Language: we PoC with python only, kept here for future extension. */
  language: "python";
  /** The failing symptom: error message, traceback, or test failure. */
  symptom: string;
  /** Ground-truth fixed code, used only for evaluation, never shown to agents. */
  referenceFix: string;
  /** Optional description of what the function is supposed to do. */
  specification: string;
}

/** One step in the reasoning trail, for the final report. */
export interface ReasoningStep {
  agent: "detective" | "qa" | "patcher" | "router";
  timestamp: string;
  summary: string;
  /** Free-form payload for debugging. */
  details?: unknown;
}

/** The mutable state object that flows through the LangGraph-style graph. */
export interface EngineState {
  /** The bug case we are currently working on. */
  case: BugCase;
  /** All hypotheses produced so far (ranked by confidence after QA). */
  hypotheses: Hypothesis[];
  /** The hypothesis currently being verified. */
  currentHypothesisId: string | null;
  /** Test results, keyed by hypothesisId. */
  testResults: Record<string, TestResult>;
  /** The final patch, once a hypothesis is confirmed. */
  patch: Patch | null;
  /** How many QA loops we have run for the current hypothesis. */
  qaAttempts: number;
  /** Hard cap on QA attempts per hypothesis. */
  maxQaAttempts: number;
  /** Hard cap on how many hypotheses we try before giving up. */
  maxHypothesesToTry: number;
  /** Index into `hypotheses` of the one we are trying. */
  hypothesisCursor: number;
  /** True once the patch has been applied and verified. */
  done: boolean;
  /** True if we gave up without a verified fix. */
  failed: boolean;
  /** Full reasoning trail, in chronological order. */
  trail: ReasoningStep[];
  /** Working directory under logs/ where intermediate files are dumped. */
  workDir: string;
}
