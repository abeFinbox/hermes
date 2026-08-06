import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { heraLimits } from './config.js';
import { parseSummary, type HeraSummaryDoc } from './summary.js';

/**
 * k6 child-process lifecycle.
 *
 * The single worst incident this feature can cause is an orphaned k6 still
 * hammering someone's API after Hermes has gone away, so the containment here is
 * deliberately belt-and-braces:
 *
 *   - the script arrives on STDIN, so it never touches disk (no secrets on the
 *     volume, no generated files to clean up)
 *   - the child gets its OWN PROCESS GROUP, and stop kills the group, not just
 *     the leader — k6 spawns worker threads and we want all of them gone
 *   - k6 is always given -d/--duration so it self-terminates, AND a parent
 *     wall-clock watchdog SIGKILLs at duration + 30s in case it does not
 *   - the child is de-prioritised and capped to cores-1, so the API stays
 *     responsive enough to serve the UI that is polling this run
 *
 * Mirrors backend-go/internal/hera/process.go.
 */

/** k6 exit codes we care about. Verified against k6 v2.0.0. */
export const K6_EXIT_THRESHOLD_FAILED = 99;
export const K6_EXIT_SCRIPT_ERROR = 107;

export const MAX_STDOUT_BYTES = 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
/** Grace between SIGTERM and SIGKILL when stopping. */
export const KILL_GRACE_MS = 5000;
/** Wall-clock slack on top of the configured duration. */
export const WATCHDOG_SLACK_MS = 30_000;

export type KilledReason = 'stop' | 'watchdog' | 'stdout-overflow' | null;

export interface K6RunResult {
  exitCode: number | null;
  signal: string | null;
  summary: HeraSummaryDoc | null;
  parseError?: string;
  stderrTail: string;
  truncatedStdout: boolean;
  killed: KilledReason;
}

export interface K6RunHandle {
  pid: number | undefined;
  /** Ask k6 to stop; it drains in-flight VUs, then we escalate. */
  stop: () => void;
  done: Promise<K6RunResult>;
}

export interface SpawnOptions {
  script: string;
  durationSec: number;
  rps: number;
  /** Exposed to the script as __ENV.HERA_RUN_ID; never baked into the source. */
  runId: string;
  /**
   * Loopback port for k6's REST API, used to sample live progress.
   * Omit to leave the API off entirely (k6's default).
   */
  restPort?: number;
}

/** Derive the run status from how k6 exited. */
export function statusForExit(exitCode: number | null, killed: KilledReason): 'passed' | 'failed' | 'error' | 'stopped' {
  if (killed === 'stop') return 'stopped';
  if (exitCode === 0) return 'passed';
  // 99 means a threshold was breached — that is a legitimate test failure, not a
  // malfunction. Everything else (including 107, a script that would not
  // compile) is an error.
  if (exitCode === K6_EXIT_THRESHOLD_FAILED) return 'failed';
  return 'error';
}

function childEnv(runId: string): NodeJS.ProcessEnv {
  const cores = Math.max(1, os.cpus().length - 1);
  return {
    ...process.env,
    // distroless has no HOME, and k6 resolves its config dir from it
    HOME: process.env.HOME || '/tmp',
    XDG_CONFIG_HOME: '/tmp',
    // Without these, every run phones home — which would make the project's
    // "no external services" claim false.
    K6_NO_USAGE_REPORT: 'true',
    K6_NO_UPDATE_CHECK: 'true',
    // Leave a core for the API that is serving the UI polling this run.
    GOMAXPROCS: String(cores),
    HERA_RUN_ID: runId,
  };
}

export function spawnK6(opts: SpawnOptions): K6RunHandle {
  const bin = heraLimits().k6Bin || 'k6';
  const args = [
    'run',
    '-', // read the script from stdin
    '--quiet',
    '--no-usage-report',
    '--duration',
    `${opts.durationSec}s`,
    '--rps',
    String(opts.rps),
  ];
  if (opts.restPort) {
    // 127.0.0.1 ONLY. k6's REST API is unauthenticated and can change VU counts,
    // so it must never be reachable off-box. --profiling-enabled stays off.
    args.push('--address', `127.0.0.1:${opts.restPort}`);
  }

  const child: ChildProcess = spawn(bin, args, {
    detached: true, // own process group, so we can kill the whole tree
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv(opts.runId),
  });

  // Best-effort: a load generator must not outrank the API it is measuring.
  try {
    if (child.pid) os.setPriority(child.pid, 10);
  } catch {
    /* not permitted on every platform; not worth failing the run over */
  }

  let stdout = '';
  let stdoutBytes = 0;
  let truncatedStdout = false;
  let stderr = '';
  let killed: KilledReason = null;
  let settled = false;

  const killGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      // negative pid = the whole process group
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };

  let graceTimer: NodeJS.Timeout | undefined;
  const escalate = () => {
    graceTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    graceTimer.unref();
  };

  const watchdog = setTimeout(() => {
    if (settled) return;
    killed = 'watchdog';
    killGroup('SIGKILL');
  }, opts.durationSec * 1000 + WATCHDOG_SLACK_MS);
  watchdog.unref();

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > MAX_STDOUT_BYTES) {
      // Runaway output would take the whole process down with it.
      truncatedStdout = true;
      killed = killed ?? 'stdout-overflow';
      killGroup('SIGKILL');
      return;
    }
    stdout += chunk;
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
    if (stderr.length > MAX_STDERR_BYTES) {
      // keep the TAIL: that is where the error is
      stderr = stderr.slice(stderr.length - MAX_STDERR_BYTES);
    }
  });

  const done = new Promise<K6RunResult>((resolve) => {
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (graceTimer) clearTimeout(graceTimer);
      const { doc, error } = parseSummary(stdout);
      resolve({
        exitCode,
        signal: signal ?? null,
        summary: doc,
        ...(error ? { parseError: error } : {}),
        stderrTail: stderr,
        truncatedStdout,
        killed,
      });
    };
    child.on('error', (err) => {
      stderr = (stderr + '\n' + String(err.message)).slice(-MAX_STDERR_BYTES);
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });

  // Feed the script in and close stdin so k6 starts.
  child.stdin?.on('error', () => {
    /* the child may die before we finish writing; close() reports it */
  });
  child.stdin?.end(opts.script);

  return {
    pid: child.pid,
    stop: () => {
      if (settled) return;
      killed = 'stop';
      killGroup('SIGTERM');
      escalate();
    },
    done,
  };
}
