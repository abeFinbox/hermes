import { Router } from 'express';
import { heraLimits } from '../hera/config.js';
import { k6Capability, resetK6Capability } from '../hera/k6-binary.js';
import { buildStepCurl } from '../hera/curl.js';
import { deriveProfile, isHeraMode, HERA_MODES, HERA_MODE_LABELS } from '../hera/profile.js';
import {
  buildSeedVars,
  clampConfig,
  collectFiles,
  deleteRun,
  getRun,
  getRunLogs,
  isRunActive,
  listRuns,
  preflight,
  startRun,
  stopRun,
  suiteFor,
} from '../hera/runner.js';
import { envNameFor, getEnvironment } from './environments.js';
import type { AuthedRequest } from '../auth.js';

/**
 * Hera (k6 load testing) routes.
 *
 * Mounted under the authenticated + role-gated /api group. Two things about the
 * permission shape are deliberate:
 *
 *   - LAUNCH is admin-only by default (HERA_ALLOW_MODERATOR=1 widens it). It is
 *     gated explicitly here rather than by falling through enforcePermissions,
 *     because loosening later is easy and tightening later breaks workflows.
 *   - STOP is in the isExecute whitelist in auth.ts, so every role including
 *     read-only npc can hit the brakes. That is the ONLY Hera route in there.
 */
export const heraRouter = Router();

const SELF_PORT = String(process.env.PORT || 4000);

// Launch rate limit, keyed by USER not IP: one NAT'd office is one IP.
const LAUNCH_WINDOW_MS = 10 * 60 * 1000;
const LAUNCH_MAX = 3;
const launches = new Map<string, number[]>();

/**
 * Peek only — does NOT consume a slot.
 *
 * The limit exists to bound load generation, and a rejected launch generates
 * none. Counting attempts would let a fumbled config lock someone out of the
 * feature, so slots are consumed in recordLaunch() once a run actually starts.
 */
function launchRateLimited(userId: string): boolean {
  const now = Date.now();
  const hits = (launches.get(userId) ?? []).filter((t) => now - t < LAUNCH_WINDOW_MS);
  launches.set(userId, hits);
  return hits.length >= LAUNCH_MAX;
}

function recordLaunch(userId: string): void {
  const now = Date.now();
  const hits = (launches.get(userId) ?? []).filter((t) => now - t < LAUNCH_WINDOW_MS);
  hits.push(now);
  launches.set(userId, hits);
}

function canLaunch(role: string | undefined): boolean {
  if (role === 'admin') return true;
  return role === 'moderator' && heraLimits().allowModerator;
}

async function capabilities(recheck: boolean) {
  if (recheck) resetK6Capability();
  const limits = heraLimits();
  const cap = await k6Capability();
  const available = limits.enabled && cap.available;
  const reason = !limits.enabled ? 'Hera is turned off on this instance (HERA_ENABLED=0).' : cap.reason;
  return {
    available,
    enabled: limits.enabled,
    version: cap.version,
    platform: cap.platform,
    ...(reason ? { reason } : {}),
    maxVus: limits.maxVus,
    maxDurationSec: limits.maxDurationSec,
    maxRps: limits.maxRps,
    maxRequests: limits.maxRequests,
    allowModerator: limits.allowModerator,
    selfMockOnly: limits.targetAllow.length === 0,
  };
}

heraRouter.get('/capabilities', async (req: AuthedRequest, res) => {
  const body = await capabilities(req.query.recheck === '1');
  res.json({ ...body, canLaunch: canLaunch(req.user?.role) });
});

// ?envId= is a per-launch override; omitting it previews the suite's default
// environment, so the preflight matches what POST / would actually run.
heraRouter.get('/preflight', async (req, res) => {
  const suiteId = String(req.query.suiteId || '');
  const suite = suiteFor(suiteId);
  if (!suite) return res.status(404).json({ error: 'Suite not found' });
  const envId = req.query.envId === undefined ? suite.defaultEnvId : String(req.query.envId) || null;
  if (envId && !getEnvironment(envId)) return res.status(404).json({ error: 'Environment not found' });
  res.json({ ...(await preflight(suite, heraLimits(), SELF_PORT, envId)), envId, envName: envNameFor(envId) });
});

// Declared before /:id so "preflight" and "capabilities" are never read as ids.
heraRouter.get('/', (req, res) => {
  const suiteId = req.query.suiteId ? String(req.query.suiteId) : undefined;
  res.json(listRuns(suiteId));
});

heraRouter.post('/', async (req: AuthedRequest, res) => {
  if (!canLaunch(req.user?.role)) {
    return res.status(403).json({
      error:
        req.user?.role === 'moderator'
          ? 'Only an admin can start a load test on this instance. Set HERA_ALLOW_MODERATOR=1 to allow moderators.'
          : 'Only an admin can start a load test.',
    });
  }
  const limits = heraLimits();
  const { suiteId, mode, ratePerSec, vus, durationSec, thinkTimeMs, p95Ms, errorRatePct, envId } = req.body || {};
  const suite = suiteFor(String(suiteId || ''));
  if (!suite) return res.status(404).json({ error: 'Suite not found' });
  const chosenEnv = envId === undefined ? suite.defaultEnvId : envId ? String(envId) : null;
  if (chosenEnv && !getEnvironment(chosenEnv)) return res.status(404).json({ error: 'Environment not found' });

  if (launchRateLimited(req.user!.id)) {
    return res.status(429).json({
      error: `Too many load tests started recently — ${LAUNCH_MAX} per ${LAUNCH_WINDOW_MS / 60000} minutes. Wait before starting another.`,
    });
  }

  const { applied, notes } = clampConfig(
    { suiteId: suite.id, mode, ratePerSec, vus, durationSec, thinkTimeMs, p95Ms, errorRatePct },
    limits,
  );

  const result = await startRun({
    suite,
    applied,
    clampNotes: notes,
    actor: {
      id: req.user!.id,
      username: req.user!.username,
      role: String(req.user!.role),
      ip: req.ip || 'unknown',
    },
    selfPort: SELF_PORT,
    envId: chosenEnv,
  });

  if (!result.ok) return res.status(result.status).json({ error: result.error });
  recordLaunch(req.user!.id); // only a run that actually started consumes a slot
  res.status(202).json({
    id: result.id,
    status: 'queued',
    appliedConfig: applied,
    clampNotes: notes,
    envId: chosenEnv,
    envName: envNameFor(chosenEnv),
  });
});

/**
 * Preview the shape of a run before starting one. Pure function of the query, no
 * suite and no side effects, so the launch form can call it on every keystroke.
 *
 * Declared before /:id so "profile" is not read as a run id.
 *
 * The client never derives stages itself: one implementation per language,
 * both covered by the parity harness, is the whole point.
 */
heraRouter.get('/profile', (req, res) => {
  const limits = heraLimits();
  const mode = isHeraMode(req.query.mode) ? req.query.mode : 'constant';
  const vus = Math.max(1, Math.min(limits.maxVus, Math.trunc(Number(req.query.vus) || 1)));
  const durationSec = Math.max(1, Math.min(limits.maxDurationSec, Math.trunc(Number(req.query.durationSec) || 1)));
  const rawRate = req.query.ratePerSec === undefined || req.query.ratePerSec === '' ? null : Number(req.query.ratePerSec);
  // NOT pre-clamped: deriveProfile clamps and explains it, so the preview says
  // the same thing the launch would.
  const target = rawRate === null ? null : Math.max(1, Math.trunc(rawRate) || 1);
  res.json({
    modes: HERA_MODES.map((m) => ({ mode: m, label: HERA_MODE_LABELS[m] })),
    maxRps: limits.maxRps,
    ...deriveProfile(mode, vus, durationSec, limits.maxRps, target),
  });
});

heraRouter.get('/:id', (req, res) => {
  const since = req.query.since === undefined ? undefined : Number(req.query.since);
  const run = getRun(req.params.id, Number.isFinite(since as number) ? (since as number) : undefined);
  if (!run) return res.status(404).json({ error: 'Load test not found' });
  res.json(run);
});

/**
 * Live k6 output. Separate from GET /:id because the log ring lives in the
 * process that spawned k6, while everything else in the payload comes from the
 * shared database: folding them together would produce a field that is
 * authoritative on one engine and empty on the other. See getRunLogs.
 */
heraRouter.get('/:id/logs', (req, res) => {
  const since = Number(req.query.sinceLine);
  const logs = getRunLogs(req.params.id, Number.isFinite(since) ? since : 0);
  if (!logs) return res.status(404).json({ error: 'Load test not found' });
  res.json(logs);
});

/**
 * A paste-runnable cURL for one step of a run — the first thing anyone wants
 * after seeing a step at 100% errors.
 *
 * Gated to the launch roles, and never persisted, because it resolves REAL
 * values including secret variables. A masked Authorization header would
 * reproduce a 401 that has nothing to do with the one being debugged, which is
 * worse than useless. Same posture as the single-step Send curl.
 *
 * Built from the suite AS IT IS NOW, not as it ran: Hera stores no request
 * snapshot. `staleWarning` says so when the suite has been edited since.
 */
heraRouter.get('/:id/curl', (req: AuthedRequest, res) => {
  if (!canLaunch(req.user?.role)) {
    return res.status(403).json({
      error:
        req.user?.role === 'moderator'
          ? 'Only an admin can see a load-test cURL on this instance (it contains real credentials). Set HERA_ALLOW_MODERATOR=1 to allow moderators.'
          : 'Only an admin can see a load-test cURL (it contains real credentials).',
    });
  }
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Load test not found' });
  const suite = suiteFor(run.suiteId);
  if (!suite) return res.status(404).json({ error: 'The suite this run used has been deleted, so its requests cannot be rebuilt.' });
  const stepId = String(req.query.stepId ?? '');
  const step = suite.steps.find((s) => s.id === stepId);
  if (!step) return res.status(404).json({ error: 'That step is no longer in the suite, so its request cannot be rebuilt.' });

  const { fileMeta } = collectFiles(suite);
  // Rebuilt against the environment the RUN used, not the suite's current
  // default: a cURL resolved against the wrong environment points at the wrong
  // host and reproduces nothing.
  const curl = buildStepCurl({ step, seedVars: buildSeedVars(suite, run.envId), fileMeta });
  // Variables captured at runtime cannot be resolved statically; the command
  // keeps them as {{name}} and the UI has to say so, or someone pastes a URL
  // with a literal {{session_id}} in it and blames the tool.
  const unresolved = [...new Set([...curl.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1]))];
  res.json({
    stepId,
    name: step.name,
    method: (step.request.method || 'GET').toUpperCase(),
    curl,
    unresolved,
    staleWarning: suite.updatedAt > run.startedAt,
  });
});

heraRouter.post('/:id/stop', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Load test not found' });
  if (!stopRun(req.params.id)) {
    return res.status(409).json({
      error: isRunActive(req.params.id)
        ? 'Run is stopping already.'
        : 'Run is not active (already finished, or running on the other backend).',
    });
  }
  res.json({ ok: true, status: 'stopping' });
});

heraRouter.delete('/:id', (req, res) => {
  if (isRunActive(req.params.id)) {
    return res.status(409).json({ error: 'Stop the run before deleting it.' });
  }
  // The hera_audit trail deliberately survives this.
  deleteRun(req.params.id);
  res.json({ ok: true });
});
