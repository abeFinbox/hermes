/**
 * Hera configuration and hard caps.
 *
 * Every knob is env-overridable but then clamped in code, in the same style as
 * the existing run-cycles clamp in routes/runs.ts and MAX_POLL_MS in
 * runner/executor.ts. A load generator that trusts its input is a weapon, so
 * the ceilings here are not advisory.
 *
 * Values are identical in backend-go/internal/hera/config.go.
 */

export interface HeraLimits {
  enabled: boolean;
  maxVus: number;
  maxDurationSec: number;
  maxRps: number;
  maxRequests: number;
  /** Extend launch permission from admin-only to moderators. */
  allowModerator: boolean;
  /** Run even when the detected CPU quota is too low for trustworthy numbers. */
  allowConstrained: boolean;
  /**
   * Hosts Hera may target. EMPTY means default-deny: only this instance's own
   * /mock API over loopback. Real targets require an explicit decision.
   */
  targetAllow: string[];
  /** Explicit k6 binary path; empty means "look on PATH". */
  k6Bin: string;
  /** Lines of k6 output kept in memory per run, for the live log panel. */
  logLines: number;
  /** Emit a diagnostic line when a step fails, so a red step is explainable. */
  diag: boolean;
  /** Diagnostic lines per step, PER VU: the real ceiling is diagMax * vus. */
  diagMax: number;
  /**
   * Include a response-body snippet in diagnostics.
   *
   * ON by default: the status code alone rarely explains a 4xx, and the error
   * message in the body is the thing an operator actually needs. The trade-off
   * is real — these lines are persisted in stderr_tail, so response payloads sit
   * at rest in the run row until it is deleted — which is why the snippet is
   * hard-truncated and why HERA_DIAG_BODY=0 turns it off for instances pointed
   * at production data.
   */
  diagBody: boolean;
  /** Hard truncation for that snippet. */
  diagBodyMax: number;
}

// Defaults / ceilings. The ceiling is the most a deployment may raise a value to.
export const DEFAULT_MAX_VUS = 20;
export const CEILING_MAX_VUS = 100;
export const DEFAULT_MAX_DURATION_SEC = 60;
export const CEILING_MAX_DURATION_SEC = 300; // matches MAX_POLL_MS (300000ms)
export const DEFAULT_MAX_RPS = 200;
export const CEILING_MAX_RPS = 1000;
export const DEFAULT_MAX_REQUESTS = 20_000;
export const CEILING_MAX_REQUESTS = 100_000;
export const DEFAULT_LOG_LINES = 2000;
export const MIN_LOG_LINES = 100;
export const CEILING_LOG_LINES = 20_000;
export const DEFAULT_DIAG_MAX = 3;
export const CEILING_DIAG_MAX = 50;
export const DEFAULT_DIAG_BODY_MAX = 512;
export const CEILING_DIAG_BODY_MAX = 2048;

/**
 * Bytes of parsed log lines held per run, independent of MAX_STDERR_BYTES.
 * The ring evicts on whichever bound trips first: lines, then bytes.
 */
export const MAX_LOG_RING_BYTES = 512 * 1024;

/** Minimum CPU (millicores) for latency numbers worth trusting. */
export const MIN_MILLICORES = 1000;
/** CPU headroom to reserve per virtual user. */
export const MILLICORES_PER_VU = 50;

function intEnv(name: string, dflt: number, min: number, ceiling: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return dflt;
  return Math.max(min, Math.min(ceiling, Math.floor(raw)));
}

function boolEnv(name: string, dflt: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return dflt;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function heraLimits(): HeraLimits {
  return {
    enabled: boolEnv('HERA_ENABLED', true),
    maxVus: intEnv('HERA_MAX_VUS', DEFAULT_MAX_VUS, 1, CEILING_MAX_VUS),
    maxDurationSec: intEnv('HERA_MAX_DURATION_SEC', DEFAULT_MAX_DURATION_SEC, 1, CEILING_MAX_DURATION_SEC),
    maxRps: intEnv('HERA_MAX_RPS', DEFAULT_MAX_RPS, 1, CEILING_MAX_RPS),
    maxRequests: intEnv('HERA_MAX_REQUESTS', DEFAULT_MAX_REQUESTS, 1, CEILING_MAX_REQUESTS),
    allowModerator: boolEnv('HERA_ALLOW_MODERATOR', false),
    allowConstrained: boolEnv('HERA_ALLOW_CONSTRAINED', false),
    targetAllow: (process.env.HERA_TARGET_ALLOW ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    k6Bin: (process.env.HERA_K6_BIN ?? '').trim(),
    logLines: intEnv('HERA_LOG_LINES', DEFAULT_LOG_LINES, MIN_LOG_LINES, CEILING_LOG_LINES),
    diag: boolEnv('HERA_DIAG', true),
    diagMax: intEnv('HERA_DIAG_MAX', DEFAULT_DIAG_MAX, 1, CEILING_DIAG_MAX),
    diagBody: boolEnv('HERA_DIAG_BODY', true),
    diagBodyMax: intEnv('HERA_DIAG_BODY_MAX', DEFAULT_DIAG_BODY_MAX, 32, CEILING_DIAG_BODY_MAX),
  };
}
