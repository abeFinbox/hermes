import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { db, FILES_DIR, INSTANCE_ID } from '../db.js';
import { getGlobals } from '../routes/variables.js';
import { getFileRow } from '../routes/files.js';
import { getSuite } from '../routes/suites.js';
import type { Suite } from '../types.js';
import { heraLimits, MILLICORES_PER_VU, type HeraLimits } from './config.js';
import { k6Capability } from './k6-binary.js';
import { generateScript, stepMetas, type HeraLoadConfig } from './script.js';
import { spawnK6, statusForExit, type K6RunHandle } from './process.js';
import { ProgressCollector, pickLoopbackPort, type HeraSample } from './progress.js';
import { interpolate, validateTarget, type ResolvedTarget } from './target.js';
import { acquireLock, heartbeat, releaseLock } from './lock.js';
import type { HeraSummaryDoc } from './summary.js';
import { lookup } from 'node:dns/promises';

/**
 * Run orchestration: validate -> generate -> spawn -> sample -> finalise.
 *
 * Mirrors backend-go/internal/hera/runner.go.
 */

/** How often progress is written to the DB. Also the lock heartbeat cadence. */
export const PERSIST_MS = 2000;
/** Cap on the persisted samples blob. */
export const MAX_SAMPLES_BYTES = 256 * 1024;

export interface HeraRequestedConfig {
  suiteId: string;
  vus: number;
  durationSec: number;
  thinkTimeMs?: number;
  p95Ms?: number | null;
  errorRatePct?: number | null;
}

export interface AppliedConfig extends HeraLoadConfig {
  suiteId: string;
}

export interface ClampResult {
  applied: AppliedConfig;
  /** Human-readable notes when a requested value was reduced. */
  notes: string[];
}

export interface PreflightStep {
  stepId: string;
  name: string;
  method: string;
  url: string;
  resolvedUrl: string;
  unresolvedTokens: string[];
  target: ResolvedTarget;
}

export interface PreflightResult {
  ok: boolean;
  steps: PreflightStep[];
  hosts: Array<{ origin: string; requests: number; external: boolean }>;
  findings: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
  estimate: { requestsPerIteration: number; unbounded: boolean; note: string };
  secretsNeeded: string[];
}

// ---------- variables & files ----------

/** Merged seed: globals first, then suite variables win (mirrors VarScope). */
export function buildSeedVars(suite: Suite): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of getGlobals()) out[g.key] = g.value;
  for (const v of suite.variables) out[v.key] = v.value;
  return out;
}

export function collectFiles(suite: Suite): {
  filePaths: Record<string, string>;
  fileMeta: Record<string, { filename: string; mime: string }>;
  totalBytes: number;
  missing: string[];
} {
  const filePaths: Record<string, string> = {};
  const fileMeta: Record<string, { filename: string; mime: string }> = {};
  const missing: string[] = [];
  let totalBytes = 0;
  for (const step of suite.steps) {
    if (!step.enabled) continue;
    for (const part of step.request.body.formData || []) {
      if (part.type !== 'file' || !part.fileId || filePaths[part.fileId]) continue;
      const row = getFileRow(part.fileId);
      if (!row) {
        missing.push(`${step.name} / ${part.key}`);
        continue;
      }
      const path = join(FILES_DIR, row.stored_name);
      try {
        totalBytes += statSync(path).size;
      } catch {
        missing.push(`${step.name} / ${part.key}`);
        continue;
      }
      filePaths[part.fileId] = path;
      fileMeta[part.fileId] = { filename: row.original_name, mime: row.mime || 'application/octet-stream' };
    }
  }
  return { filePaths, fileMeta, totalBytes, missing };
}

const TOKEN_SCAN = /\{\{\s*([^}\s]+)\s*\}\}/g;

function tokensIn(text: string): string[] {
  return [...String(text).matchAll(TOKEN_SCAN)].map((m) => m[1]);
}

/**
 * Replace the origin with the resolved IP, keeping the rest of the (possibly
 * still templated) URL. This is the "pin" half of resolve-then-pin.
 */
export function pinnedUrl(interpolatedUrl: string, target: ResolvedTarget): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(interpolatedUrl);
  if (!m || !target.resolvedIp) return interpolatedUrl;
  const ip = target.resolvedIp.includes(':') ? `[${target.resolvedIp}]` : target.resolvedIp;
  const isDefaultPort =
    (target.scheme === 'http' && target.port === '80') || (target.scheme === 'https' && target.port === '443');
  const authority = isDefaultPort ? ip : `${ip}:${target.port}`;
  return m[1] + authority + m[3];
}

// ---------- caps ----------

export function clampConfig(req: HeraRequestedConfig, limits: HeraLimits, capCores?: number): ClampResult {
  const notes: string[] = [];
  let maxVus = limits.maxVus;
  if (capCores && capCores > 0) {
    const byCpu = Math.max(1, Math.floor(capCores / MILLICORES_PER_VU));
    if (byCpu < maxVus) {
      maxVus = byCpu;
      notes.push(`Virtual users capped to ${byCpu} by the CPU available to this instance.`);
    }
  }

  const vus = Math.max(1, Math.min(maxVus, Math.trunc(Number(req.vus) || 1)));
  if (vus < Math.trunc(Number(req.vus) || 1)) notes.push(`Virtual users reduced from ${req.vus} to ${vus} (server limit).`);

  const durationSec = Math.max(1, Math.min(limits.maxDurationSec, Math.trunc(Number(req.durationSec) || 1)));
  if (durationSec < Math.trunc(Number(req.durationSec) || 1)) {
    notes.push(`Duration reduced from ${req.durationSec}s to ${durationSec}s (server limit).`);
  }

  const rps = limits.maxRps;
  const thinkTimeMs = Math.max(0, Math.min(60_000, Math.trunc(Number(req.thinkTimeMs) || 0)));

  return {
    applied: {
      suiteId: req.suiteId,
      vus,
      durationSec,
      rps,
      thinkTimeMs,
      p95Ms: req.p95Ms === undefined || req.p95Ms === null ? null : Math.max(1, Math.trunc(req.p95Ms)),
      errorRatePct:
        req.errorRatePct === undefined || req.errorRatePct === null
          ? null
          : Math.max(0, Math.min(100, Math.trunc(req.errorRatePct))),
    },
    notes,
  };
}

// ---------- preflight ----------

export async function preflight(suite: Suite, limits: HeraLimits, selfPort: string): Promise<PreflightResult> {
  const seed = buildSeedVars(suite);
  const enabled = suite.steps.filter((s) => s.enabled);
  const findings: PreflightResult['findings'] = [];
  const steps: PreflightStep[] = [];
  const hostCounts = new Map<string, { requests: number; external: boolean }>();

  let anyPolling = false;
  let pollTimeoutTotal = 0;
  let scriptSteps = 0;
  let respTimeAssertions = 0;

  for (const step of enabled) {
    const resolved = interpolate(step.request.url, seed);
    const target = await validateTarget(step.request.url, seed, {
      limits,
      selfPort,
      resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
    });
    steps.push({
      stepId: step.id,
      name: step.name,
      method: (step.request.method || 'GET').toUpperCase(),
      url: step.request.url,
      resolvedUrl: resolved,
      unresolvedTokens: [...new Set(tokensIn(resolved))],
      target,
    });
    if (target.ok && target.host) {
      const origin = `${target.scheme}://${target.host}:${target.port}`;
      const prev = hostCounts.get(origin) ?? { requests: 0, external: !target.selfMock };
      hostCounts.set(origin, { requests: prev.requests + 1, external: prev.external });
    }
    if (step.polling?.enabled) {
      anyPolling = true;
      pollTimeoutTotal += step.polling.timeoutMs;
    }
    if (step.validations.script?.trim() || step.captures.script?.trim()) scriptSteps++;
    respTimeAssertions += step.validations.visual.filter((a) => a.type === 'response-time-below').length;
  }

  if (enabled.length === 0) {
    findings.push({ level: 'error', message: 'This suite has no enabled steps, so there is nothing to load-test.' });
  }
  for (const s of steps) {
    if (!s.target.ok) findings.push({ level: 'error', message: `${s.name}: ${s.target.reason}` });
  }

  if (scriptSteps > 0) {
    findings.push({
      level: 'info',
      message: `${scriptSteps} step(s) use capture/validation scripts. They run unchanged on the Hera shim, with three differences: variables.set(..., 'global') is iteration-local, console.log only emits for the first iteration of VU 1, and there is no 2-second per-script timeout.`,
    });
  }
  if (anyPolling) {
    findings.push({
      level: 'warn',
      message:
        'Polling is enabled, so the request count is unbounded — the rps cap and the run duration are the real limits. Expect few completed iterations, and read hera_poll_wait_ms for time-to-completion.',
    });
  }
  if (respTimeAssertions > 0) {
    findings.push({
      level: 'info',
      message: `${respTimeAssertions} response-time assertion(s) will run as checks. Consider setting the p95 threshold instead — under load a per-request limit fails noisily.`,
    });
  }

  const { totalBytes, missing } = collectFiles(suite);
  if (missing.length > 0) {
    findings.push({
      level: 'error',
      message: `Attached file missing from the store for: ${missing.join(', ')}. Re-attach it before running.`,
    });
  }
  if (totalBytes > 1024 * 1024) {
    findings.push({
      level: 'warn',
      message: `Attached files total ${(totalBytes / 1024 / 1024).toFixed(1)} MB. k6 loads init data per virtual user, so memory grows with the VU count.`,
    });
  }

  const secretsNeeded = suite.variables.filter((v) => v.secret && !v.value).map((v) => v.key);
  if (secretsNeeded.length > 0) {
    findings.push({
      level: 'warn',
      message: `These secret variables are empty and will be sent blank: ${secretsNeeded.join(', ')}.`,
    });
  }

  const cap = await k6Capability();
  if (!limits.enabled) findings.push({ level: 'error', message: 'Hera is turned off on this instance (HERA_ENABLED=0).' });
  else if (!cap.available) findings.push({ level: 'error', message: cap.reason ?? 'k6 is not available.' });

  return {
    ok: findings.every((f) => f.level !== 'error'),
    steps,
    hosts: [...hostCounts.entries()].map(([origin, v]) => ({ origin, requests: v.requests, external: v.external })),
    findings,
    estimate: {
      requestsPerIteration: enabled.length,
      unbounded: anyPolling,
      note: anyPolling
        ? 'Unbounded — polling re-sends until its stop condition or timeout.'
        : `About ${enabled.length} request(s) per iteration.`,
    },
    secretsNeeded,
  };
}

// ---------- run lifecycle ----------

/**
 * Registered BEFORE k6 is spawned, so a stop that arrives during the spawn
 * window is remembered rather than dropped with a 409. "Click launch, then
 * immediately click stop" is a real sequence.
 */
interface ActiveRun {
  handle?: K6RunHandle;
  collector?: ProgressCollector;
  timer?: NodeJS.Timeout;
  stopRequested: boolean;
}

const activeRuns = new Map<string, ActiveRun>();

export function isRunActive(id: string): boolean {
  return activeRuns.has(id);
}

export function stopRun(id: string): boolean {
  const run = activeRuns.get(id);
  if (!run) return false;
  run.stopRequested = true;
  run.handle?.stop();
  return true;
}

export interface StartRunInput {
  suite: Suite;
  applied: AppliedConfig;
  clampNotes: string[];
  actor: { id: string; username: string; role: string; ip: string };
  selfPort: string;
}

export interface StartRunOutput {
  ok: true;
  id: string;
}
export interface StartRunRejected {
  ok: false;
  status: number;
  error: string;
}

function trimSamples(samples: HeraSample[]): string {
  let json = JSON.stringify(samples);
  // Hard bound: the row is rewritten on every persist, so it must stay small.
  while (json.length > MAX_SAMPLES_BYTES && samples.length > 2) {
    samples = samples.filter((_, i) => i % 2 === 0);
    json = JSON.stringify(samples);
  }
  return json;
}

export function audit(event: string, runId: string | null, input: Partial<StartRunInput> & { detail?: unknown; suiteId?: string; hosts?: string[] }): void {
  db.prepare(
    `INSERT INTO hera_audit (id, at, event, run_id, user_id, username, role, source_ip, backend, suite_id, target_hosts_json, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'node', ?, ?, ?)`,
  ).run(
    randomUUID(),
    new Date().toISOString(),
    event,
    runId,
    input.actor?.id ?? '',
    input.actor?.username ?? '',
    input.actor?.role ?? '',
    input.actor?.ip ?? '',
    input.suiteId ?? input.suite?.id ?? '',
    JSON.stringify(input.hosts ?? []),
    JSON.stringify(input.detail ?? {}),
  );
}

export async function startRun(input: StartRunInput): Promise<StartRunOutput | StartRunRejected> {
  const limits = heraLimits();
  const { suite, applied } = input;
  const cap = await k6Capability();
  if (!limits.enabled || !cap.available) {
    return { ok: false, status: 503, error: cap.reason ?? 'Hera is not available on this instance.' };
  }

  const pre = await preflight(suite, limits, input.selfPort);
  if (!pre.ok) {
    const first = pre.findings.find((f) => f.level === 'error');
    audit('reject', null, { ...input, suiteId: suite.id, detail: { reason: first?.message } });
    return { ok: false, status: 400, error: first?.message ?? 'Preflight failed.' };
  }

  // rps x duration must not exceed the request ceiling
  const projected = applied.rps * applied.durationSec;
  if (!pre.estimate.unbounded && projected > limits.maxRequests) {
    const msg = `This run projects about ${projected} requests, over the ${limits.maxRequests} limit. Lower the duration, or raise HERA_MAX_REQUESTS.`;
    audit('reject', null, { ...input, suiteId: suite.id, detail: { reason: msg } });
    return { ok: false, status: 400, error: msg };
  }

  const id = randomUUID();
  const holder = acquireLock(id);
  if (holder) {
    return {
      ok: false,
      status: 409,
      error: `A load test is already running on this database (run ${holder.runId.slice(0, 8)}). Only one runs at a time, so results stay comparable.`,
    };
  }

  const seed = buildSeedVars(suite);
  const { filePaths, fileMeta } = collectFiles(suite);
  const pins: Record<string, { url: string; hostHeader: string }> = {};
  for (const s of pre.steps) {
    if (s.target.ok && s.target.host) {
      pins[s.stepId] = { url: pinnedUrl(s.resolvedUrl, s.target), hostHeader: s.target.host };
    }
  }

  const { script } = generateScript({ suite, seedVars: seed, load: applied, filePaths, fileMeta, pins });
  const metas = stepMetas(suite);
  const now = new Date().toISOString();
  const hosts = pre.hosts.map((h) => h.origin);

  db.prepare(
    `INSERT INTO hera_runs (id, suite_id, suite_name, status, config_json, applied_config_json, target_hosts_json,
      k6_version, backend, owner_instance, heartbeat_at, started_at, samples_json, steps_json, confidence,
      created_by_user_id, created_by_username, created_by_role, source_ip)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, 'node', ?, ?, ?, '[]', ?, 'unknown', ?, ?, ?, ?)`,
  ).run(
    id,
    suite.id,
    suite.name,
    JSON.stringify({ ...applied, clampNotes: input.clampNotes }),
    JSON.stringify(applied),
    JSON.stringify(hosts),
    cap.version ?? '',
    INSTANCE_ID,
    now,
    now,
    JSON.stringify(metas.map((m) => ({ ...m, requests: 0 }))),
    input.actor.id,
    input.actor.username,
    input.actor.role,
    input.actor.ip,
  );

  audit('launch', id, {
    ...input,
    suiteId: suite.id,
    hosts,
    detail: { applied, clampNotes: input.clampNotes, pinned: Object.values(pins).map((p) => p.url) },
  });
  console.error(
    `[hera] launch run=${id} by=${input.actor.username}(${input.actor.role}) ip=${input.actor.ip} ` +
      `suite=${suite.name} vus=${applied.vus} duration=${applied.durationSec}s rps=${applied.rps} hosts=${hosts.join(',')}`,
  );

  // Register BEFORE spawning so an immediate stop is not lost in the gap
  // between the 202 response and k6 actually starting.
  activeRuns.set(id, { stopRequested: false });

  // Fire and forget; the UI polls GET /api/hera/:id.
  void execute(id, script, applied);
  return { ok: true, id };
}

async function execute(id: string, script: string, applied: AppliedConfig): Promise<void> {
  let collector: ProgressCollector | undefined;
  try {
    const port = await pickLoopbackPort();
    collector = new ProgressCollector(port);
    collector.start();
    const handle = spawnK6({
      script,
      durationSec: applied.durationSec,
      rps: applied.rps,
      runId: id,
      restPort: port,
    });

    const timer = setInterval(() => {
      const samples = collector!.samples;
      const status = samples.some((s) => s.vus > 0) ? 'running' : 'ramping';
      db.prepare('UPDATE hera_runs SET status = ?, samples_json = ? WHERE id = ? AND status IN (?, ?, ?)').run(
        status,
        trimSamples(samples),
        id,
        'queued',
        'ramping',
        'running',
      );
      heartbeat(id);
    }, PERSIST_MS);
    timer.unref();

    const entry = activeRuns.get(id) ?? { stopRequested: false };
    entry.handle = handle;
    entry.collector = collector;
    entry.timer = timer;
    activeRuns.set(id, entry);
    if (entry.stopRequested) handle.stop(); // stop arrived while we were spawning

    const result = await handle.done;
    clearInterval(timer);
    await collector.pollOnce();
    collector.stop();

    const status = statusForExit(result.exitCode, result.killed);
    const summary = result.summary;
    finalise(id, {
      status,
      summary,
      samples: collector.samples,
      exitCode: result.exitCode,
      stderrTail: result.stderrTail,
      parseError: result.parseError,
      steps: summary?.steps ?? null,
      killed: result.killed,
    });
  } catch (e: any) {
    finalise(id, {
      status: 'error',
      summary: null,
      samples: collector?.samples ?? [],
      exitCode: null,
      stderrTail: String(e?.message ?? e),
      steps: null,
      killed: null,
    });
  } finally {
    activeRuns.delete(id);
    releaseLock(id);
  }
}

function finalise(
  id: string,
  data: {
    status: string;
    summary: HeraSummaryDoc | null;
    samples: HeraSample[];
    exitCode: number | null;
    stderrTail: string;
    parseError?: string;
    steps: HeraSummaryDoc['steps'] | null;
    killed: string | null;
  },
): void {
  // A run that produced no summary cannot be called passed, whatever k6 said.
  let status = data.status;
  if (status === 'passed' && !data.summary) status = 'error';

  const stderr = data.parseError ? `${data.parseError}\n${data.stderrTail}` : data.stderrTail;
  db.prepare(
    `UPDATE hera_runs SET status = ?, finished_at = ?, summary_json = ?, samples_json = ?, steps_json = ?,
      stderr_tail = ?, exit_code = ?, heartbeat_at = ? WHERE id = ?`,
  ).run(
    status,
    new Date().toISOString(),
    data.summary ? JSON.stringify(data.summary.summary) : null,
    trimSamples(data.samples),
    JSON.stringify(data.steps ?? []),
    stderr.slice(-64 * 1024),
    data.exitCode,
    new Date().toISOString(),
    id,
  );
  console.error(`[hera] finish run=${id} status=${status} exit=${data.exitCode} killed=${data.killed ?? '-'}`);
  db.prepare(
    `INSERT INTO hera_audit (id, at, event, run_id, backend, detail_json) VALUES (?, ?, 'finish', ?, 'node', ?)`,
  ).run(randomUUID(), new Date().toISOString(), id, JSON.stringify({ status, exitCode: data.exitCode, killed: data.killed }));
}

// ---------- reads ----------

function rowToListItem(r: any) {
  return {
    id: r.id,
    suiteId: r.suite_id,
    suiteName: r.suite_name,
    status: r.status,
    config: JSON.parse(r.applied_config_json || '{}'),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    summary: r.summary_json ? JSON.parse(r.summary_json) : null,
    confidence: r.confidence,
    k6Version: r.k6_version,
    backend: r.backend,
    exitCode: r.exit_code,
  };
}

export function listRuns(suiteId?: string) {
  const rows = suiteId
    ? (db.prepare('SELECT * FROM hera_runs WHERE suite_id = ? ORDER BY started_at DESC LIMIT 100').all(suiteId) as any[])
    : (db.prepare('SELECT * FROM hera_runs ORDER BY started_at DESC LIMIT 100').all() as any[]);
  return rows.map(rowToListItem);
}

export function getRun(id: string, sinceT?: number) {
  const r = db.prepare('SELECT * FROM hera_runs WHERE id = ?').get(id) as any;
  if (!r) return null;
  const all: HeraSample[] = JSON.parse(r.samples_json || '[]');
  const samples = sinceT === undefined ? all : all.filter((s) => s.t > sinceT);
  return {
    ...rowToListItem(r),
    requestedConfig: JSON.parse(r.config_json || '{}'),
    targetHosts: JSON.parse(r.target_hosts_json || '[]'),
    steps: JSON.parse(r.steps_json || '[]'),
    samples,
    sampleCount: all.length,
    stderrTail: r.stderr_tail || '',
  };
}

export function deleteRun(id: string): void {
  db.prepare('DELETE FROM hera_runs WHERE id = ?').run(id);
}

export function suiteFor(suiteId: string): Suite | null {
  return getSuite(suiteId);
}
