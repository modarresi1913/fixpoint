/**
 * The Reasoning Graph
 *
 * LangGraph is a Python library; in this Node.js PoC we implement the
 * same idea manually: a small set of named "nodes" (pure functions of
 * EngineState -> EngineState) and an explicit edge function that picks
 * the next node.
 *
 * Topology:
 *
 *   start
 *     v
 *   detective  ───────────► (sets hypotheses[])
 *     v
 *   select_next  ─────────► (picks the highest-confidence hypothesis
 *     |                     not yet tried; if none left -> fail)
 *     v
 *   qa  ──────────────────► (writes test, runs against buggy code)
 *     v
 *   qa_router
 *     |  test exposes bug? ──no──► select_next  (hypothesis was wrong)
 *     |  yes
 *     v
 *   patcher  ─────────────► (writes the fix)
 *     v
 *   verify
 *     |  test passes on patched code? ──no──► select_next (patch failed)
 *     |  yes
 *     v
 *   done
 *
 * This is exactly the closed-loop reasoning described in the design doc:
 *   hypothesis -> test -> verify -> (backtrack if wrong) -> commit.
 */
import { runDetective } from "../agents/detective.js";
import { runQAEnhanced as runQA } from "../agents/qa_enhanced.js";
import { runPatcher } from "../agents/patcher.js";
import type { EngineState, ReasoningStep } from "../types/engine.js";
import { ensureDir, nowIso, writeFile } from "../utils.js";

type NodeName =
  | "start"
  | "detective"
  | "select_next"
  | "qa"
  | "qa_router"
  | "patcher"
  | "verify"
  | "done"
  | "fail";

/** Initialize state for a fresh case. */
export function makeInitialState(
  case_: EngineState["case"],
  workDir: string
): EngineState {
  return {
    case: case_,
    hypotheses: [],
    currentHypothesisId: null,
    testResults: {},
    patch: null,
    qaAttempts: 0,
    maxQaAttempts: 1,
    maxHypothesesToTry: 3,
    hypothesisCursor: 0,
    done: false,
    failed: false,
    trail: [],
    workDir,
  };
}

function pushStep(state: EngineState, step: ReasoningStep): EngineState {
  state.trail.push(step);
  return state;
}

/** Node: start — set up the work directory. */
async function nodeStart(state: EngineState): Promise<EngineState> {
  await ensureDir(state.workDir);
  await writeFile(
    `${state.workDir}/buggy.py`,
    `# Original buggy code (case ${state.case.id})\n` + state.case.buggyCode
  );
  return pushStep(state, {
    agent: "router",
    timestamp: nowIso(),
    summary: `Started case "${state.case.id}": ${state.case.description}`,
  });
}

/** Node: detective — generate hypotheses. */
async function nodeDetective(state: EngineState): Promise<EngineState> {
  const { hypotheses, step } = await runDetective(state.case);
  state.hypotheses = hypotheses;
  state.hypothesisCursor = 0;
  return pushStep(state, step);
}

/** Node: select_next — pick the next hypothesis to try. */
async function nodeSelectNext(state: EngineState): Promise<EngineState> {
  if (state.hypothesisCursor >= state.hypotheses.length) {
    state.failed = true;
    return pushStep(state, {
      agent: "router",
      timestamp: nowIso(),
      summary: `No more hypotheses to try (${state.hypotheses.length} exhausted). Giving up.`,
    });
  }
  if (state.hypothesisCursor >= state.maxHypothesesToTry) {
    state.failed = true;
    return pushStep(state, {
      agent: "router",
      timestamp: nowIso(),
      summary: `Reached maxHypothesesToTry=${state.maxHypothesesToTry}. Giving up.`,
    });
  }
  const h = state.hypotheses[state.hypothesisCursor];
  state.currentHypothesisId = h.id;
  state.qaAttempts = 0;
  return pushStep(state, {
    agent: "router",
    timestamp: nowIso(),
    summary: `Selected hypothesis #${state.hypothesisCursor + 1}/${state.hypotheses.length}: "${h.title}" (${(h.confidence * 100).toFixed(0)}%)`,
  });
}

/** Node: qa — write a test for the current hypothesis and run it on buggy code. */
async function nodeQA(state: EngineState): Promise<EngineState> {
  const h = state.hypotheses.find((x) => x.id === state.currentHypothesisId);
  if (!h) throw new Error("QA: no current hypothesis");
  state.qaAttempts += 1;
  const { testResult } = await runQA(
    state.case,
    h,
    state.workDir,
    state.qaAttempts
  );
  state.testResults[h.id] = testResult;
  return pushStep(state, {
    agent: "qa",
    timestamp: nowIso(),
    summary: `Wrote test for "${h.title}". Bug-exposing test: ${testResult.passed ? "YES ✓" : "NO ✗"} (${testResult.passedCount} passed / ${testResult.failedCount} failed in ${testResult.durationMs}ms)`,
    details: { rationale: "(see qa_*/rationale.md)" },
  });
}

/** Node: qa_router — decide whether to patch or skip the hypothesis. */
async function nodeQARouter(state: EngineState): Promise<EngineState> {
  const h = state.hypotheses.find((x) => x.id === state.currentHypothesisId);
  if (!h) throw new Error("qa_router: no current hypothesis");
  const tr = state.testResults[h.id];
  if (tr.passed) {
    // Test correctly exposes the bug -> proceed to patch.
    return pushStep(state, {
      agent: "router",
      timestamp: nowIso(),
      summary: `QA test exposes the bug. Proceeding to patch.`,
    });
  }
  // Test does NOT expose the bug -> the hypothesis is probably wrong.
  state.hypothesisCursor += 1;
  return pushStep(state, {
    agent: "router",
    timestamp: nowIso(),
    summary: `QA test does not expose the bug. Hypothesis probably wrong. Moving to next.`,
  });
}

/** Node: patcher — apply the fix and verify. */
async function nodePatcher(state: EngineState): Promise<EngineState> {
  const h = state.hypotheses.find((x) => x.id === state.currentHypothesisId);
  if (!h) throw new Error("patcher: no current hypothesis");
  const tr = state.testResults[h.id];
  const { patch, verification } = await runPatcher(
    state.case,
    h,
    tr.testFile,
    state.workDir
  );
  state.patch = patch;
  state.testResults[h.id] = verification; // overwrite with the patched-code result
  return pushStep(state, {
    agent: "patcher",
    timestamp: nowIso(),
    summary: `Applied patch: "${patch.summary}". Verification: ${verification.passed ? "PASS ✓" : "FAIL ✗"} (${verification.passedCount} passed / ${verification.failedCount} failed)`,
    details: { reasoning: patch.reasoning },
  });
}

/** Node: verify — final verdict on the current hypothesis. */
async function nodeVerify(state: EngineState): Promise<EngineState> {
  const h = state.hypotheses.find((x) => x.id === state.currentHypothesisId);
  if (!h) throw new Error("verify: no current hypothesis");
  const tr = state.testResults[h.id];
  if (tr.passed) {
    state.done = true;
    return pushStep(state, {
      agent: "router",
      timestamp: nowIso(),
      summary: `Patch verified. Done.`,
    });
  }
  // Patch did not pass -> move on.
  state.hypothesisCursor += 1;
  state.patch = null;
  return pushStep(state, {
    agent: "router",
    timestamp: nowIso(),
    summary: `Patch did not pass verification. Moving to next hypothesis.`,
  });
}

/** Edge function: given current state + just-run node, what's next? */
function nextNode(state: EngineState, justRan: NodeName): NodeName {
  if (state.failed) return "fail";
  if (state.done) return "done";
  switch (justRan) {
    case "start":
      return "detective";
    case "detective":
      return "select_next";
    case "select_next":
      return state.failed ? "fail" : "qa";
    case "qa":
      return "qa_router";
    case "qa_router":
      // qa_router either advanced the cursor (-> select_next) or kept it (-> patcher)
      return "patcher";
    case "patcher":
      return "verify";
    case "verify":
      // verify either set done (-> done) or advanced the cursor (-> select_next)
      return "select_next";
    case "done":
    case "fail":
      return justRan;
  }
}

/** Decide which hypothesis cursor to use after qa_router / verify failed. */
function applyCursorSideEffect(state: EngineState, justRan: NodeName): NodeName {
  if (justRan === "qa_router" || justRan === "verify") {
    const h = state.hypotheses.find((x) => x.id === state.currentHypothesisId);
    const tr = h ? state.testResults[h.id] : undefined;
    if (justRan === "qa_router" && tr && !tr.passed) {
      return "select_next";
    }
    if (justRan === "verify" && tr && !tr.passed) {
      return "select_next";
    }
  }
  return nextNode(state, justRan);
}

const NODES: Record<
  Exclude<NodeName, "done" | "fail">,
  (s: EngineState) => Promise<EngineState>
> = {
  start: nodeStart,
  detective: nodeDetective,
  select_next: nodeSelectNext,
  qa: nodeQA,
  qa_router: nodeQARouter,
  patcher: nodePatcher,
  verify: nodeVerify,
};

/**
 * Run the graph to completion. Stops when state.done or state.failed
 * or a safety cap on iterations is hit.
 */
export async function runGraph(
  state: EngineState,
  opts: { maxIterations?: number; onStep?: (s: EngineState, node: NodeName) => void } = {}
): Promise<EngineState> {
  const maxIterations = opts.maxIterations ?? 12;
  let current: NodeName = "start";
  let iter = 0;

  while (current !== "done" && current !== "fail" && iter < maxIterations) {
    iter += 1;
    const fn = NODES[current];
    if (!fn) {
      throw new Error(`No node implementation for "${current}"`);
    }
    state = await fn(state);
    opts.onStep?.(state, current);
    current = applyCursorSideEffect(state, current);
  }

  if (iter >= maxIterations && !state.done && !state.failed) {
    state.failed = true;
    state.trail.push({
      agent: "router",
      timestamp: nowIso(),
      summary: `Hit maxIterations=${maxIterations}. Aborting.`,
    });
  }
  return state;
}

export type { NodeName };
