import { Router } from 'express';
import { db } from '../db.js';
import { getSuite } from './suites.js';
import { getEnvironment } from './environments.js';
import { startRun, executeStep, stopRun, runScriptBench, VarScope } from '../runner/executor.js';
import { defaultSettings, type Run, type Suite, type Step } from '../types.js';

export const runsRouter = Router();

function rowToRun(row: any, includeResults: boolean): Run {
  return {
    id: row.id,
    suiteId: row.suite_id,
    suiteName: row.suite_name,
    status: row.status,
    cycles: row.cycles,
    stopOnFailure: !!row.stop_on_failure,
    envId: row.env_id ?? null,
    envName: row.env_name ?? '',
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cycleResults: includeResults ? JSON.parse(row.cycle_results_json) : [],
    summary: row.summary_json ? JSON.parse(row.summary_json) : null,
  };
}

// Trigger: POST /api/runs  { suiteId, cycles?, stopOnFailure?, envId? }
//
// envId is a per-run override; omitting it falls back to the suite's default
// environment. Sending null explicitly means "no environment" — that is why the
// two cases are distinguished rather than collapsed with ||.
runsRouter.post('/', (req, res) => {
  const { suiteId, cycles, stopOnFailure, envId } = req.body || {};
  const suite = getSuite(suiteId);
  if (!suite) return res.status(404).json({ error: 'Suite not found' });
  if (!suite.steps.some((s) => s.enabled)) return res.status(400).json({ error: 'Suite has no enabled steps' });
  const chosenEnv = envId === undefined ? suite.defaultEnvId : envId ? String(envId) : null;
  if (chosenEnv && !getEnvironment(chosenEnv)) return res.status(404).json({ error: 'Environment not found' });
  const n = Math.max(1, Math.min(100, Number(cycles) || suite.settings.defaultCycles || 1));
  const run = startRun(suite, n, stopOnFailure !== undefined ? !!stopOnFailure : suite.settings.stopOnFailure, chosenEnv);
  res.status(202).json({ id: run.id, status: run.status, envId: run.envId, envName: run.envName });
});

/**
 * Run a SINGLE step ad-hoc (the "Send" button in the editor).
 * Body: { step, suiteVariables?, settings? } — uses the step exactly as the
 * editor has it (including unsaved edits) so you can test one request in
 * isolation. Suite/global variables resolve as usual; suite-scope captures
 * are returned so the UI can fold them into the working suite variables and
 * chain the next step. Nothing is persisted.
 */
runsRouter.post('/step', async (req, res) => {
  const { step, suiteVariables, settings, envId } = req.body || {};
  if (!step || typeof step !== 'object' || !step.request) {
    return res.status(400).json({ error: 'A step object with a request is required' });
  }
  const suite: Suite = {
    id: 'ad-hoc',
    name: 'ad-hoc',
    description: '',
    collectionId: null,
    steps: [step as Step],
    variables: Array.isArray(suiteVariables) ? suiteVariables : [],
    settings: { ...defaultSettings(), ...(settings || {}) },
    defaultEnvId: envId ? String(envId) : null,
    createdAt: '',
    updatedAt: '',
  };
  try {
    const scope = new VarScope(suite, suite.defaultEnvId);
    const result = await executeStep(step as Step, scope, suite, { withCurl: true, fullBody: true });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Step execution failed' });
  }
});

/**
 * Try a validation / capture / poll-stop script against a HAND-WRITTEN response.
 *
 * Body: { mode, code, visualAssertions?, visualCaptures?, response, suiteVariables?, envId? }
 * where response is { status?, statusText?, headers?, timeMs?, body? }.
 *
 * No HTTP request is made and nothing is persisted — not even a global-scope
 * capture (see runScriptBench). Listed in the execute whitelist in auth.ts, so
 * read-only npc can use the bench: it is strictly less powerful than the "Send"
 * they already have.
 */
runsRouter.post('/try-script', (req, res) => {
  const { mode, code, visualAssertions, visualCaptures, response, suiteVariables, envId } = req.body || {};
  if (mode !== 'validate' && mode !== 'capture' && mode !== 'poll') {
    return res.status(400).json({ error: "mode must be one of 'validate', 'capture', 'poll'" });
  }
  if (typeof code !== 'string' && code !== undefined) {
    return res.status(400).json({ error: 'code must be a string' });
  }
  if (envId && !getEnvironment(String(envId))) return res.status(404).json({ error: 'Environment not found' });
  try {
    res.json(
      runScriptBench({
        mode,
        code: String(code ?? ''),
        visualAssertions: Array.isArray(visualAssertions) ? visualAssertions : [],
        visualCaptures: Array.isArray(visualCaptures) ? visualCaptures : [],
        response: response && typeof response === 'object' ? response : {},
        suiteVariables: Array.isArray(suiteVariables) ? suiteVariables : [],
        envId: envId ? String(envId) : null,
      }),
    );
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Script bench failed' });
  }
});

// Stop an in-flight run. 409 if the run isn't currently executing in this process.
runsRouter.post('/:id/stop', (req, res) => {
  if (!stopRun(req.params.id)) {
    return res.status(409).json({ error: 'Run is not active (already finished, or not running on this server)' });
  }
  res.json({ ok: true });
});

runsRouter.get('/', (req, res) => {
  const suiteId = req.query.suiteId as string | undefined;
  const rows = (suiteId
    ? db.prepare('SELECT * FROM runs WHERE suite_id = ? ORDER BY started_at DESC LIMIT 100').all(suiteId)
    : db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 100').all()) as any[];
  res.json(rows.map((r) => rowToRun(r, false)));
});

runsRouter.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'Run not found' });
  res.json(rowToRun(row, true));
});

runsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM runs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/**
 * Report generation STUB.
 * Returns a structured report document derived from the run. This is the
 * extension point for real HTML/PDF report rendering later — keep the shape,
 * swap the renderer.
 */
runsRouter.post('/:id/report', (req, res) => {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'Run not found' });
  const run = rowToRun(row, true);
  if (run.status === 'running') return res.status(409).json({ error: 'Run is still in progress' });

  const report = {
    stub: true,
    format: 'json',
    generatedAt: new Date().toISOString(),
    title: `Test report — ${run.suiteName}`,
    run: {
      id: run.id,
      suite: run.suiteName,
      status: run.status,
      cycles: run.cycles,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    summary: run.summary,
    cycles: run.cycleResults.map((c) => ({
      cycle: c.cycle,
      passed: c.passed,
      steps: c.steps.map((s) => ({
        name: s.name,
        status: s.status,
        httpStatus: s.response?.status ?? null,
        timeMs: s.response?.timeMs ?? null,
        assertions: s.assertions,
        captured: s.captured.map((cv) => ({ key: cv.key, scope: cv.scope })),
        error: s.error ?? null,
      })),
    })),
    todo: 'Replace this stub with HTML/PDF rendering (e.g. server-side template + puppeteer or a React print view).',
  };
  res.json(report);
});
