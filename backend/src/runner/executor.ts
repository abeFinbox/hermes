import axios from 'axios';
import { readFileSync } from 'node:fs';
import { JSONPath } from 'jsonpath-plus';
import { db } from '../db.js';
import { getGlobals, setGlobal } from '../routes/variables.js';
import { resolveStoredFile } from '../routes/files.js';
import { runScript, type SandboxResponse } from './sandbox.js';
import {
  newId,
  type Suite, type Step, type Run, type StepResult, type CycleResult, type RunSummary,
  type AssertionResult, type CapturedValue, type Assertion, type CaptureRule, type PollAttempt,
} from '../types.js';

const MAX_STORED_BODY = 64 * 1024; // request-body preview cap
const MAX_RUN_RESPONSE_BODY = 5 * 1024 * 1024; // persisted-run response cap (single-step Send is uncapped)
const MAX_POLL_MS = 5 * 60 * 1000; // hard cap on total polling duration per step
const MAX_POLL_ATTEMPT_BODY = 8 * 1024; // per-attempt body kept for poll history
const MAX_POLL_ATTEMPTS = 50; // keep the most recent N attempts

// Interruptible delay — resolves after `ms`, or early if the run is aborted.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// ---------- variable resolution ----------

export class VarScope {
  private globalVars = new Map<string, string>();
  private suiteVars = new Map<string, string>();
  private runtimeVars = new Map<string, string>();
  // Non-empty values of variables flagged `secret` — used to mask secrets out
  // of the persisted cURL (see redactSecrets).
  private secretValues = new Set<string>();
  globalsDirty = false;

  constructor(suite: Suite) {
    for (const g of getGlobals()) {
      this.globalVars.set(g.key, g.value);
      if (g.secret && g.value) this.secretValues.add(g.value);
    }
    for (const v of suite.variables) {
      this.suiteVars.set(v.key, v.value);
      if (v.secret && v.value) this.secretValues.add(v.value);
    }
  }

  /** Replace any secret variable's resolved value wherever it appears. */
  redactSecrets(text: string): string {
    let out = text;
    for (const sv of this.secretValues) out = out.split(sv).join('<redacted>');
    return out;
  }

  get(key: string): string | undefined {
    // runtime (captured this run) > suite > global — mirrors Postman scope precedence
    return this.runtimeVars.get(key) ?? this.suiteVars.get(key) ?? this.globalVars.get(key);
  }

  set(key: string, value: string, scope: 'suite' | 'global' | 'runtime') {
    if (scope === 'global') {
      this.globalVars.set(key, value);
      setGlobal(key, value); // persisted immediately
      this.globalsDirty = true;
    } else if (scope === 'suite') {
      this.suiteVars.set(key, value);
      this.runtimeVars.set(key, value);
    } else {
      this.runtimeVars.set(key, value);
    }
  }

  resolve(text: string): string {
    if (!text) return text;
    let out = text;
    for (let i = 0; i < 5 && /\{\{[^}]+\}\}/.test(out); i++) {
      out = out.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (m, key) => {
        const v = this.get(key);
        return v !== undefined ? v : m;
      });
    }
    return out;
  }

  unresolvedIn(text: string): string[] {
    const resolved = this.resolve(text || '');
    return [...resolved.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1]);
  }
}

// ---------- visual assertions & captures ----------

function jsonPathFirst(bodyText: string, expression: string): unknown {
  const json = JSON.parse(bodyText);
  const results = JSONPath({ path: expression.startsWith('$') ? expression : `$.${expression}`, json, wrap: true }) as unknown[];
  return results.length ? results[0] : undefined;
}

function runVisualAssertion(a: Assertion, resp: SandboxResponse): AssertionResult {
  const name = describeAssertion(a);
  try {
    switch (a.type) {
      case 'status-equals': {
        const exp = Number(a.expected);
        return { name, passed: resp.status === exp, message: resp.status === exp ? undefined : `got ${resp.status}` };
      }
      case 'jsonpath-exists': {
        const v = jsonPathFirst(resp.bodyText, a.expression || '');
        return { name, passed: v !== undefined, message: v !== undefined ? undefined : 'path not found' };
      }
      case 'jsonpath-equals': {
        const v = jsonPathFirst(resp.bodyText, a.expression || '');
        const actual = typeof v === 'string' ? v : JSON.stringify(v);
        const ok = actual === a.expected;
        return { name, passed: ok, message: ok ? undefined : `got ${actual}` };
      }
      case 'header-equals': {
        const actual = resp.headers[(a.expression || '').toLowerCase()];
        const ok = actual === a.expected;
        return { name, passed: ok, message: ok ? undefined : `got ${actual ?? '(missing)'}` };
      }
      case 'body-contains': {
        const ok = resp.bodyText.includes(a.expected || '');
        return { name, passed: ok, message: ok ? undefined : 'text not found in body' };
      }
      case 'response-time-below': {
        const limit = Number(a.expected);
        const ok = resp.time < limit;
        return { name, passed: ok, message: ok ? undefined : `took ${resp.time}ms` };
      }
      default:
        return { name, passed: false, message: `unknown assertion type ${(a as any).type}` };
    }
  } catch (e: any) {
    return { name, passed: false, message: e?.message || String(e) };
  }
}

export function describeAssertion(a: Assertion): string {
  switch (a.type) {
    case 'status-equals': return `status = ${a.expected}`;
    case 'jsonpath-exists': return `${a.expression} exists`;
    case 'jsonpath-equals': return `${a.expression} = ${a.expected}`;
    case 'header-equals': return `header ${a.expression} = ${a.expected}`;
    case 'body-contains': return `body contains "${a.expected}"`;
    case 'response-time-below': return `response time < ${a.expected}ms`;
    default: return 'assertion';
  }
}

function runVisualCapture(c: CaptureRule, resp: SandboxResponse): { value: string } {
  switch (c.source) {
    case 'status':
      return { value: String(resp.status) };
    case 'header': {
      const v = resp.headers[(c.expression || '').toLowerCase()];
      if (v === undefined) throw new Error(`header "${c.expression}" not present`);
      return { value: v };
    }
    case 'body-text':
      return { value: resp.bodyText };
    case 'body-jsonpath': {
      const v = jsonPathFirst(resp.bodyText, c.expression || '');
      if (v === undefined) throw new Error(`JSONPath "${c.expression}" matched nothing`);
      return { value: typeof v === 'string' ? v : JSON.stringify(v) };
    }
    default:
      throw new Error(`unknown capture source ${(c as any).source}`);
  }
}

// ---------- step execution ----------

export interface ExecuteOpts {
  signal?: AbortSignal; // aborts the in-flight HTTP request when a run is stopped
  withCurl?: boolean; // attach a reproducible cURL of the actual request
  fullBody?: boolean; // keep the FULL response body (single-step Send); persisted runs stay capped
}

export async function executeStep(step: Step, scope: VarScope, suite: Suite, opts: ExecuteOpts = {}): Promise<StepResult> {
  const result: StepResult = { stepId: step.id, name: step.name, status: 'passed', assertions: [], captured: [], logs: [] };

  // build request with variables resolved
  const method = step.request.method.toUpperCase();
  let url = scope.resolve(step.request.url.trim());
  const headers: Record<string, string> = {};
  for (const h of step.request.headers) if (h.enabled && h.key) headers[scope.resolve(h.key)] = scope.resolve(h.value);

  const params = step.request.params.filter((p) => p.enabled && p.key);
  if (params.length) {
    const qs = params.map((p) => `${encodeURIComponent(scope.resolve(p.key))}=${encodeURIComponent(scope.resolve(p.value))}`).join('&');
    // avoid duplicating params already present in the raw URL
    const [base, existing] = url.split('?', 2);
    url = existing ? `${base}?${existing}&${qs}` : `${base}?${qs}`;
  }

  if (step.request.auth.type === 'bearer') headers['Authorization'] = `Bearer ${scope.resolve(step.request.auth.token)}`;
  if (step.request.auth.type === 'basic') {
    const cred = Buffer.from(`${scope.resolve(step.request.auth.username)}:${scope.resolve(step.request.auth.password)}`).toString('base64');
    headers['Authorization'] = `Basic ${cred}`;
  }

  let data: string | FormData | undefined;
  let bodyPreview: string | undefined;
  const bodilessMethod = method === 'GET' || method === 'HEAD';
  const sendsBody = step.request.body.mode !== 'none' && (!bodilessMethod || !!step.request.body.sendWithGet);
  if (sendsBody && step.request.body.mode === 'form-data') {
    // multipart: text parts appended as strings, file parts read from the managed store.
    // axios sets the multipart Content-Type (with boundary) itself, so we don't set it here.
    const fd = new FormData();
    const summary: string[] = [];
    for (const f of step.request.body.formData || []) {
      if (!f.enabled || !f.key) continue;
      const key = scope.resolve(f.key);
      if (f.type === 'file') {
        const stored = resolveStoredFile(f.fileId);
        if (!stored) {
          result.status = 'error';
          result.error = `Field "${key}" isn't linked to a file in the store. Open this request's form-data body and re-select the file from the dropdown. (A re-uploaded file gets a new id, so re-uploading alone won't fix it — you must pick it again.)`;
          result.request = { method, url, headers: redactHeaders(headers) };
          return result;
        }
        const buf = readFileSync(stored.path);
        fd.append(key, new Blob([buf], stored.mime ? { type: stored.mime } : {}), stored.name);
        summary.push(`${key}=@${stored.name} (${buf.length} bytes)`);
      } else {
        const value = scope.resolve(f.value);
        fd.append(key, value);
        summary.push(`${key}=${value}`);
      }
    }
    data = fd;
    bodyPreview = `multipart/form-data — ${summary.length} field(s): ${summary.join(', ')}`;
  } else if (sendsBody) {
    const text = scope.resolve(step.request.body.content);
    data = text;
    bodyPreview = text;
    if (step.request.body.mode === 'json' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    if (step.request.body.mode === 'form' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  const unresolved = scope.unresolvedIn(url);
  result.request = { method, url, headers: redactHeaders(headers), body: bodyPreview && bodyPreview.length > MAX_STORED_BODY ? bodyPreview.slice(0, MAX_STORED_BODY) : bodyPreview };
  // Send (fullBody) gets a paste-runnable curl; persisted runs get a redacted one.
  if (opts.withCurl) result.curl = buildCurl(method, url, headers, step, scope, !opts.fullBody);
  if (unresolved.length) {
    result.status = 'error';
    result.error = `Unresolved variables in URL: ${unresolved.map((u) => `{{${u}}}`).join(', ')}`;
    return result;
  }

  // send — a single attempt. Returns the response, or a terminal outcome
  // ('aborted' | 'error') already recorded on `result`.
  const sendOnce = async (): Promise<{ resp?: SandboxResponse; done?: true }> => {
    const started = Date.now();
    try {
      const axiosResp = await axios.request({
        method: method as any,
        url,
        headers,
        data,
        timeout: suite.settings.requestTimeoutMs,
        responseType: 'text',
        transformResponse: [(d) => d],
        validateStatus: () => true,
        maxRedirects: 5,
        signal: opts.signal,
      });
      const timeMs = Date.now() - started;
      const respHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(axiosResp.headers || {})) respHeaders[k.toLowerCase()] = String(v);
      const bodyText = typeof axiosResp.data === 'string' ? axiosResp.data : JSON.stringify(axiosResp.data ?? '');
      return { resp: { status: axiosResp.status, statusText: axiosResp.statusText || '', headers: respHeaders, time: timeMs, bodyText } };
    } catch (e: any) {
      if (opts.signal?.aborted) {
        result.status = 'skipped';
        result.error = 'Stopped';
        return { done: true };
      }
      result.status = 'error';
      result.error = `Request failed: ${e?.message || String(e)}`;
      return { done: true };
    }
  };

  let resp!: SandboxResponse;
  const poll = step.polling;
  if (poll?.enabled && poll.stopScript?.trim()) {
    // re-send on an interval until stop() is called or the timeout elapses
    const timeoutMs = Math.min(Math.max(1000, poll.timeoutMs || 30000), MAX_POLL_MS);
    const intervalMs = Math.max(250, poll.intervalMs || 2000);
    const deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();
    const attemptsLog: PollAttempt[] = [];
    let stopped = false;
    let attempts = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const s = await sendOnce();
      if (s.done) return result;
      resp = s.resp!;
      attempts++;
      const out = runScript(poll.stopScript, resp, (k) => scope.get(k), 'poll');
      result.logs.push(...out.logs);
      const scriptErr = !!out.error;
      // record this attempt's response so the UI can show poll history
      attemptsLog.push({
        attempt: attempts,
        status: resp.status,
        statusText: resp.statusText,
        timeMs: resp.time,
        body: resp.bodyText.slice(0, MAX_POLL_ATTEMPT_BODY),
        bodyTruncated: resp.bodyText.length > MAX_POLL_ATTEMPT_BODY,
        stopped: out.stopRequested,
      });
      if (attemptsLog.length > MAX_POLL_ATTEMPTS) attemptsLog.splice(0, attemptsLog.length - MAX_POLL_ATTEMPTS);
      if (scriptErr) {
        result.assertions.push({ name: 'poll stop condition', passed: false, message: out.error! });
        result.status = 'failed';
        break;
      }
      if (out.stopRequested) { stopped = true; break; }
      if (Date.now() + intervalMs >= deadline) break;
      if (opts.signal?.aborted) { result.status = 'skipped'; result.error = 'Stopped'; return result; }
      await sleep(intervalMs, opts.signal);
      if (opts.signal?.aborted) { result.status = 'skipped'; result.error = 'Stopped'; return result; }
    }
    result.pollAttempts = attemptsLog;
    result.logs.push(`[poll] ${attempts} attempt(s) over ${Date.now() - startedAt}ms`);
    if (!stopped && result.status === 'passed') {
      result.assertions.push({ name: 'polling', passed: false, message: `Stop condition not met within ${timeoutMs}ms (${attempts} attempts)` });
      result.status = 'failed';
    }
  } else {
    const s = await sendOnce();
    if (s.done) return result;
    resp = s.resp!;
  }

  // Single-step Send (opts.withCurl) is for debugging — keep the FULL body.
  // Persisted runs cap it so the runs table doesn't bloat across cycles/steps.
  const bodyCap = opts.fullBody ? resp.bodyText.length : MAX_RUN_RESPONSE_BODY;
  result.response = {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
    timeMs: resp.time,
    body: resp.bodyText.slice(0, bodyCap),
    bodyTruncated: resp.bodyText.length > bodyCap,
  };

  // validations: visual then script
  for (const a of step.validations.visual) {
    const r = runVisualAssertion(a, resp);
    result.assertions.push(r);
    if (!r.passed) result.status = 'failed';
  }
  if (step.validations.script?.trim()) {
    const out = runScript(step.validations.script, resp, (k) => scope.get(k), 'validate');
    result.assertions.push(...out.tests);
    result.logs.push(...out.logs);
    if (out.error) {
      result.assertions.push({ name: 'validation script', passed: false, message: out.error });
    }
    if (out.failed) result.status = 'failed';
  }

  // captures: run unless step failed and suite says not to
  const shouldCapture = result.status === 'passed' || suite.settings.runCapturesOnFailure;
  if (shouldCapture) {
    for (const c of step.captures.visual) {
      if (!c.targetVariable) continue;
      try {
        const { value } = runVisualCapture(c, resp);
        scope.set(c.targetVariable, value, c.scope);
        result.captured.push({ key: c.targetVariable, value, scope: c.scope });
      } catch (e: any) {
        result.assertions.push({ name: `capture ${c.targetVariable}`, passed: false, message: e?.message || String(e) });
        result.status = result.status === 'passed' ? 'failed' : result.status;
      }
    }
    if (step.captures.script?.trim()) {
      const out = runScript(step.captures.script, resp, (k) => scope.get(k), 'capture');
      result.logs.push(...out.logs);
      for (const sv of out.setVariables) {
        scope.set(sv.key, sv.value, sv.scope);
        result.captured.push({ key: sv.key, value: sv.value, scope: sv.scope });
      }
      if (out.error) {
        result.assertions.push({ name: 'capture script', passed: false, message: out.error });
        result.status = result.status === 'passed' ? 'failed' : result.status;
      }
    }
  }

  return result;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /authorization|api-key|x-api-key|cookie/i.test(k) ? v.slice(0, 12) + '…(redacted)' : v;
  }
  return out;
}

// Reproducible cURL for the actual (variable-resolved) request. When `redact`
// is set (the copy PERSISTED with a run), sensitive headers and secret-variable
// values are masked. The single-step "Send" builds it unredacted so the command
// works when pasted into a terminal.
function buildCurl(method: string, url: string, headers: Record<string, string>, step: Step, scope: VarScope, redact = false): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`; // single-quote for POSIX shells
  const mask = (s: string) => (redact ? scope.redactSecrets(s) : s);
  const lines = [`curl -X ${method} ${q(mask(url))}`];
  for (const [k, v] of Object.entries(headers)) {
    let value = v;
    if (redact) {
      value = mask(value);
      if (/authorization|api-key|x-api-key|cookie/i.test(k) && value.length > 12) {
        value = value.slice(0, 12) + '…(redacted)';
      }
    }
    lines.push(`-H ${q(`${k}: ${value}`)}`);
  }
  const body = step.request.body;
  const bodilessMethod = method === 'GET' || method === 'HEAD';
  const sendsBody = body.mode !== 'none' && (!bodilessMethod || !!body.sendWithGet);
  if (sendsBody) {
    if (body.mode === 'form-data') {
      for (const f of body.formData || []) {
        if (!f.enabled || !f.key) continue;
        const key = scope.resolve(f.key);
        if (f.type === 'file') {
          const stored = resolveStoredFile(f.fileId);
          lines.push(`-F ${q(`${mask(key)}=@${stored ? stored.name : '<missing-file>'}`)}`);
        } else {
          lines.push(`-F ${q(`${mask(key)}=${mask(scope.resolve(f.value))}`)}`);
        }
      }
    } else {
      lines.push(`--data-raw ${q(mask(scope.resolve(body.content)))}`);
    }
  }
  return lines.join(' \\\n  ');
}

// ---------- run orchestration ----------

interface RunControl {
  abort: AbortController;
  cancelled: boolean;
}
// In-memory registry of runs currently executing in THIS process, so a stop
// request can cancel them. (A 'running' row with no entry here is stale — e.g.
// left over from a previous process — and cannot be stopped.)
const activeRuns = new Map<string, RunControl>();

/** Request cancellation of an in-flight run. Returns false if it isn't active here. */
export function stopRun(runId: string): boolean {
  const ctrl = activeRuns.get(runId);
  if (!ctrl) return false;
  ctrl.cancelled = true;
  ctrl.abort.abort(); // interrupt any request currently in flight
  return true;
}

export function startRun(suite: Suite, cycles: number, stopOnFailure: boolean): Run {
  const run: Run = {
    id: newId(),
    suiteId: suite.id,
    suiteName: suite.name,
    status: 'running',
    cycles,
    stopOnFailure,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cycleResults: [],
    summary: null,
  };
  persistRun(run);
  activeRuns.set(run.id, { abort: new AbortController(), cancelled: false });
  // fire and forget; UI polls GET /api/runs/:id
  void executeRun(run, suite);
  return run;
}

async function executeRun(run: Run, suite: Suite) {
  const ctrl = activeRuns.get(run.id)!;
  const startedMs = Date.now();
  try {
    for (let cycle = 1; cycle <= run.cycles && !ctrl.cancelled; cycle++) {
      const scope = new VarScope(suite); // fresh scope per cycle; globals persist across cycles
      const cycleResult: CycleResult = { cycle, passed: true, steps: [] };
      run.cycleResults.push(cycleResult);
      let aborted = false;
      for (const step of suite.steps) {
        if (!step.enabled || aborted || ctrl.cancelled) {
          cycleResult.steps.push({ stepId: step.id, name: step.name, status: 'skipped', assertions: [], captured: [], logs: [] });
          continue;
        }
        const stepResult = await executeStep(step, scope, suite, { signal: ctrl.abort.signal, withCurl: true });
        cycleResult.steps.push(stepResult);
        if (stepResult.status !== 'passed') {
          cycleResult.passed = false;
          if (run.stopOnFailure && !ctrl.cancelled) aborted = true;
        }
        persistRun(run); // progressive persistence so the UI can poll live progress
      }
      if (!cycleResult.passed && run.stopOnFailure && !ctrl.cancelled) break;
    }
    run.status = ctrl.cancelled ? 'stopped' : run.cycleResults.every((c) => c.passed) ? 'passed' : 'failed';
  } catch (e: any) {
    run.status = ctrl.cancelled ? 'stopped' : 'error';
  } finally {
    activeRuns.delete(run.id);
  }
  run.finishedAt = new Date().toISOString();
  run.summary = summarize(run, Date.now() - startedMs);
  persistRun(run);
}

function summarize(run: Run, durationMs: number): RunSummary {
  const s: RunSummary = { totalSteps: 0, passedSteps: 0, failedSteps: 0, erroredSteps: 0, skippedSteps: 0, totalAssertions: 0, passedAssertions: 0, durationMs };
  for (const c of run.cycleResults) {
    for (const st of c.steps) {
      s.totalSteps++;
      if (st.status === 'passed') s.passedSteps++;
      else if (st.status === 'failed') s.failedSteps++;
      else if (st.status === 'error') s.erroredSteps++;
      else s.skippedSteps++;
      s.totalAssertions += st.assertions.length;
      s.passedAssertions += st.assertions.filter((a) => a.passed).length;
    }
  }
  return s;
}

function persistRun(run: Run) {
  db.prepare(
    `INSERT INTO runs (id, suite_id, suite_name, status, cycles, stop_on_failure, started_at, finished_at, cycle_results_json, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
       cycle_results_json = excluded.cycle_results_json, summary_json = excluded.summary_json`,
  ).run(
    run.id, run.suiteId, run.suiteName, run.status, run.cycles, run.stopOnFailure ? 1 : 0,
    run.startedAt, run.finishedAt, JSON.stringify(run.cycleResults), run.summary ? JSON.stringify(run.summary) : null,
  );
}
