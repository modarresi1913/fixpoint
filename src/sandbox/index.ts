/**
 * Isolated Sandbox
 *
 * Runs Python test files in a child process with:
 *  - a fresh temp working directory (no access to the engine's source);
 *  - a hard timeout (so an infinite loop can't hang the engine);
 *  - the buggy/fixed code written to disk *only* inside that temp dir.
 *
 * NOTE for production: replace this with a real Docker container
 * (python:3.11-slim, --network=none, --read-only, --memory=256m).
 * For PoC we trust the OS-level isolation of subprocess + /tmp.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDir } from "../utils.js";

export interface SandboxRunInput {
  /** Full content of main.py — the code under test. */
  codeFile: string;
  /** Full content of test_main.py — the pytest file. */
  testFile: string;
  /** Wall-clock budget in ms. Default 15s. */
  timeoutMs?: number;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True if the process was killed by the timeout. */
  timedOut: boolean;
  durationMs: number;
  /** The temp directory used. Caller may keep it for debugging. */
  workDir: string;
}

/**
 * Write the code + test into a fresh temp dir and run `python -m pytest`.
 * Returns stdout/stderr/exitCode regardless of outcome — never throws.
 */
export async function runPythonTests(
  input: SandboxRunInput
): Promise<SandboxRunResult> {
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "shc-sandbox-")
  );
  const codePath = path.join(workDir, "main.py");
  const testPath = path.join(workDir, "test_main.py");

  await fs.writeFile(codePath, input.codeFile, "utf8");
  await fs.writeFile(testPath, input.testFile, "utf8");

  const start = Date.now();
  const result = await new Promise<SandboxRunResult>((resolve) => {
    const proc = spawn("python3", ["-m", "pytest", "test_main.py", "-v", "--tb=short"], {
      cwd: workDir,
      env: {
        ...process.env,
        // Strip env vars that could let tests reach the engine's source.
        PYTHONPATH: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, input.timeoutMs ?? 15_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - start,
        workDir,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + `\n[sandbox error] ${err.message}\n`,
        exitCode: -1,
        timedOut: false,
        durationMs: Date.now() - start,
        workDir,
      });
    });
  });

  return result;
}

/**
 * Parse pytest's verbose output to count pass/fail.
 * Pytest -v prints lines like:
 *   test_main.py::test_add PASSED                                  [ 50%]
 *   test_main.py::test_subtract FAILED                             [100%]
 */
export function parsePytestCounts(stdout: string): {
  passedCount: number;
  failedCount: number;
} {
  const passed = (stdout.match(/\bPASSED\b/g) || []).length;
  const failed = (stdout.match(/\bFAILED\b/g) || []).length;
  return { passedCount: passed, failedCount: failed };
}

/** Persist a sandbox run to disk for post-mortem inspection. */
export async function persistSandboxRun(
  run: SandboxRunResult,
  input: SandboxRunInput,
  outDir: string
): Promise<void> {
  await ensureDir(outDir);
  await fs.writeFile(path.join(outDir, "main.py"), input.codeFile, "utf8");
  await fs.writeFile(path.join(outDir, "test_main.py"), input.testFile, "utf8");
  await fs.writeFile(path.join(outDir, "stdout.txt"), run.stdout, "utf8");
  await fs.writeFile(path.join(outDir, "stderr.txt"), run.stderr, "utf8");
  await fs.writeFile(
    path.join(outDir, "meta.json"),
    JSON.stringify(
      {
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
      },
      null,
      2
    ),
    "utf8"
  );
}
