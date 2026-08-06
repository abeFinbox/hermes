import { Router } from 'express';
import { heraLimits } from '../hera/config.js';
import { k6Capability, resetK6Capability } from '../hera/k6-binary.js';
import {
  clampConfig,
  deleteRun,
  getRun,
  isRunActive,
  listRuns,
  preflight,
  startRun,
  stopRun,
  suiteFor,
} from '../hera/runner.js';
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

heraRouter.get('/preflight', async (req, res) => {
  const suiteId = String(req.query.suiteId || '');
  const suite = suiteFor(suiteId);
  if (!suite) return res.status(404).json({ error: 'Suite not found' });
  res.json(await preflight(suite, heraLimits(), SELF_PORT));
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
  const { suiteId, vus, durationSec, thinkTimeMs, p95Ms, errorRatePct } = req.body || {};
  const suite = suiteFor(String(suiteId || ''));
  if (!suite) return res.status(404).json({ error: 'Suite not found' });

  if (launchRateLimited(req.user!.id)) {
    return res.status(429).json({
      error: `Too many load tests started recently — ${LAUNCH_MAX} per ${LAUNCH_WINDOW_MS / 60000} minutes. Wait before starting another.`,
    });
  }

  const { applied, notes } = clampConfig(
    { suiteId: suite.id, vus, durationSec, thinkTimeMs, p95Ms, errorRatePct },
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
  });

  if (!result.ok) return res.status(result.status).json({ error: result.error });
  recordLaunch(req.user!.id); // only a run that actually started consumes a slot
  res.status(202).json({ id: result.id, status: 'queued', appliedConfig: applied, clampNotes: notes });
});

heraRouter.get('/:id', (req, res) => {
  const since = req.query.since === undefined ? undefined : Number(req.query.since);
  const run = getRun(req.params.id, Number.isFinite(since as number) ? (since as number) : undefined);
  if (!run) return res.status(404).json({ error: 'Load test not found' });
  res.json(run);
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
