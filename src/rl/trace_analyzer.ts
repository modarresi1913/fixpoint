/**
 * Trace Analyzer
 * ==============
 *
 * Walks the logs/ directory, finds every closed-loop run, and
 * reconstructs a structured TraceExample for each.
 *
 * Sources of truth (in priority order):
 *   1. download/swebench_scale_results.json   (the scale runner's output)
 *   2. download/swebench_v2_results.json      (the v2 runner's output)
 *   3. download/swebench_results.json         (the fast-path runner's output)
 *   4. logs/swebench_XXX/ directories        (per-case artifacts)
 *
 * We merge these: the JSON files give us the high-level outcomes
 * (status, judge verdict), and the on-disk logs give us the full
 * hypothesis text and the buggy/fixed code.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  HypothesisOutcome,
  TraceExample,
} from "./types.js";
import { annotateHypothesesWithRewards } from "./reward.js";

const DOWNLOAD_DIR = "/home/z/my-project/download";
const LOGS_DIR = "/home/z/my-project/scripts/self-healing-engine/logs";

interface ScaleResultRow {
  caseId: string;
  repo: string;
  functionName: string;
  filePath: string;
  addedLines: number;
  removedLines: number;
  detectiveTopHypothesis: string | null;
  qaExposedBug: boolean | null;
  qaHypothesesTried: number;
  patcherSummary: string | null;
  patcherReasoning: string | null;
  patcherOutput: string | null;
  verificationPassed: boolean | null;
  judgeVerdict:
    | { verdict: string; score: number; reasoning: string }
    | null;
  status: "fixed" | "partial" | "failed" | "no_patch" | "error";
  durationMs: number;
}

interface ScaleResults {
  startedAt: string;
  endedAt: string | null;
  results: ScaleResultRow[];
}

async function readJsonIfExists<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * For a given case_id, find the most recent log directory under logs/
 * that matches. We look at the buggy.py and patcher_XXX/main.py files
 * to recover the actual code.
 */
async function findLogDirForCase(caseId: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(LOGS_DIR);
    const matches = entries
      .filter((e) => e.includes(caseId))
      .sort(); // lexical sort = chronological because of the timestamp suffix
    if (matches.length === 0) return null;
    return path.join(LOGS_DIR, matches[matches.length - 1]);
  } catch {
    return null;
  }
}

async function readBuggyAndFix(
  logDir: string
): Promise<{ buggy: string; fixed: string | null }> {
  const buggyPath = path.join(logDir, "buggy.py");
  let buggy = "";
  try {
    buggy = await fs.readFile(buggyPath, "utf8");
  } catch {
    // The file has a header comment; strip it for cleaner analysis.
  }
  // Strip the "# Original buggy code" header if present.
  buggy = buggy.replace(/^# Original buggy code[^\n]*\n/, "");

  // The patcher output is the closest we have to the "fixed" code.
  // We look for patcher_h*/main.py.
  let fixed: string | null = null;
  try {
    const entries = await fs.readdir(logDir);
    const patcherDirs = entries
      .filter((e) => e.startsWith("patcher_h"))
      .sort();
    if (patcherDirs.length > 0) {
      const fixedPath = path.join(logDir, patcherDirs[patcherDirs.length - 1], "main.py");
      fixed = await fs.readFile(fixedPath, "utf8");
    }
  } catch {
    // ignore
  }

  return { buggy, fixed };
}

/**
 * Try to recover the symptom from the case's dataset entry.
 * We don't have a direct link from the results JSON to the dataset,
 * so we re-load the dataset and match by id.
 */
async function loadDatasetCase(caseId: string): Promise<any | null> {
  const datasets = [
    "/home/z/my-project/scripts/self-healing-engine/datasets/swebench_cases_v2_large.json",
    "/home/z/my-project/scripts/self-healing-engine/datasets/swebench_cases_v2.json",
    "/home/z/my-project/scripts/self-healing-engine/datasets/swebench_cases.json",
  ];
  for (const p of datasets) {
    const data = await readJsonIfExists<{ cases: any[] }>(p);
    if (data?.cases) {
      const found = data.cases.find((c) => c.id === caseId);
      if (found) return found;
    }
  }
  return null;
}

function synthesiseSymptom(case_: any): string {
  // fail_to_pass may be a JSON-encoded string in the raw dataset.
  let failingTestsRaw: any = case_.fail_to_pass;
  if (typeof failingTestsRaw === "string") {
    try {
      failingTestsRaw = JSON.parse(failingTestsRaw);
    } catch {
      failingTestsRaw = [failingTestsRaw];
    }
  }
  if (!Array.isArray(failingTestsRaw)) failingTestsRaw = [];

  const failingTests = failingTestsRaw
    .filter((t: unknown) => typeof t === "string" && t.trim().length > 0)
    .slice(0, 3)
    .map((t: string) => `  - ${t}`)
    .join("\n");
  return (
    `Issue from ${case_.repo}:\n${(case_.problem_statement || "").slice(0, 800)}\n\n` +
    `Failing tests after the bug:\n${failingTests || "  (none specified)"}`
  );
}

/**
 * Build a TraceExample from one scale-results row.
 *
 * Because the scale results JSON only stores the *top* hypothesis and
 * the final verdict (not all 3 hypotheses the Detective produced),
 * we have to reconstruct the other hypotheses from the per-case log
 * directory if it exists. If we can't, we still emit a TraceExample
 * with just the top hypothesis — that's enough for the preference
 * dataset's "chosen vs rejected" pairing at the case level.
 */
async function buildTraceExample(row: ScaleResultRow): Promise<TraceExample | null> {
  const case_ = await loadDatasetCase(row.caseId);
  const logDir = await findLogDirForCase(row.caseId);
  const { buggy, fixed } = logDir
    ? await readBuggyAndFix(logDir)
    : { buggy: "", fixed: null };

  if (!case_) {
    // Can't recover the buggy code — skip.
    return null;
  }

  const buggyCode =
    case_.buggy_code_function || case_.buggy_code_snippet || buggy || "";
  const referenceFix =
    case_.fixed_code_function || case_.fixed_code_snippet || fixed || "";
  const symptom = synthesiseSymptom(case_);

  // Build the hypothesis list. We only have the top one from the JSON;
  // if we found a log dir, we could parse more, but for the PoC we
  // emit a single-hypothesis trace. The preference dataset builder
  // handles single-hypothesis traces by pairing them across cases.
  const hypotheses: HypothesisOutcome[] = [];
  if (row.detectiveTopHypothesis) {
    hypotheses.push({
      title: row.detectiveTopHypothesis,
      reasoning: "(not recovered — see log dir)",
      proposedFix: row.patcherSummary || "(not recovered)",
      confidence: 0.7, // default for top-ranked; real value was in the log
      rank: 1,
      qaExposedBug: row.qaExposedBug,
      patcherVerified: row.verificationPassed,
      judgeVerdict:
        (row.judgeVerdict?.verdict as HypothesisOutcome["judgeVerdict"]) || null,
      reward: 0, // filled in below
    });
  }

  const annotated = annotateHypothesesWithRewards(hypotheses);

  return {
    caseId: row.caseId,
    repo: row.repo,
    filePath: row.filePath,
    functionName: row.functionName,
    buggyCode,
    symptom,
    referenceFix,
    hypotheses: annotated,
    finalStatus: row.status,
    durationMs: row.durationMs,
    sourceLogDir: logDir || "(not found)",
  };
}

/**
 * Walk every JSON results file we've ever written and build a
 * de-duplicated list of TraceExamples.
 */
export async function loadTraceCorpus(): Promise<TraceExample[]> {
  const sources = [
    `${DOWNLOAD_DIR}/swebench_scale_results.json`,
    `${DOWNLOAD_DIR}/swebench_v2_results.json`,
    `${DOWNLOAD_DIR}/swebench_results.json`,
  ];

  const seen = new Set<string>();
  const traces: TraceExample[] = [];

  for (const p of sources) {
    const data = await readJsonIfExists<ScaleResults>(p);
    if (!data?.results) continue;
    for (const row of data.results) {
      if (seen.has(row.caseId)) continue;
      seen.add(row.caseId);
      const trace = await buildTraceExample(row);
      if (trace) traces.push(trace);
    }
  }

  return traces;
}

/**
 * Summary stats for a corpus — used in the report.
 */
export interface CorpusStats {
  totalTraces: number;
  tracesWithJudge: number;
  tracesFixed: number;
  tracesPartial: number;
  tracesFailed: number;
  tracesNoPatch: number;
  tracesError: number;
  tracesWithQaExposed: number;
  tracesWithVerifierPassed: number;
  /** Per-repo counts. */
  byRepo: Record<string, number>;
  /** Reward distribution (histogram buckets). */
  rewardHistogram: { bucket: string; count: number }[];
}

export function summariseCorpus(traces: TraceExample[]): CorpusStats {
  const stats: CorpusStats = {
    totalTraces: traces.length,
    tracesWithJudge: 0,
    tracesFixed: 0,
    tracesPartial: 0,
    tracesFailed: 0,
    tracesNoPatch: 0,
    tracesError: 0,
    tracesWithQaExposed: 0,
    tracesWithVerifierPassed: 0,
    byRepo: {},
    rewardHistogram: [
      { bucket: "[-1.0, -0.5)", count: 0 },
      { bucket: "[-0.5,  0.0)", count: 0 },
      { bucket: "[ 0.0,  0.3)", count: 0 },
      { bucket: "[ 0.3,  0.5)", count: 0 },
      { bucket: "[ 0.5,  0.8)", count: 0 },
      { bucket: "[ 0.8,  1.0]", count: 0 },
    ],
  };

  for (const t of traces) {
    stats.byRepo[t.repo] = (stats.byRepo[t.repo] || 0) + 1;
    if (t.finalStatus === "fixed") stats.tracesFixed++;
    if (t.finalStatus === "partial") stats.tracesPartial++;
    if (t.finalStatus === "failed") stats.tracesFailed++;
    if (t.finalStatus === "no_patch") stats.tracesNoPatch++;
    if (t.finalStatus === "error") stats.tracesError++;
    if (t.hypotheses.some((h) => h.judgeVerdict)) stats.tracesWithJudge++;
    if (t.hypotheses.some((h) => h.qaExposedBug === true))
      stats.tracesWithQaExposed++;
    if (t.hypotheses.some((h) => h.patcherVerified === true))
      stats.tracesWithVerifierPassed++;

    for (const h of t.hypotheses) {
      const r = h.reward;
      if (r < -0.5) stats.rewardHistogram[0].count++;
      else if (r < 0) stats.rewardHistogram[1].count++;
      else if (r < 0.3) stats.rewardHistogram[2].count++;
      else if (r < 0.5) stats.rewardHistogram[3].count++;
      else if (r < 0.8) stats.rewardHistogram[4].count++;
      else stats.rewardHistogram[5].count++;
    }
  }

  return stats;
}
