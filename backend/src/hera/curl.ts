/**
 * A paste-runnable cURL for one Hera step.
 *
 * Why this exists: a load test tells you a step is 100% red, and the next thing
 * anyone does is try the request by hand. Rebuilding it from the suite editor is
 * error-prone precisely when you are in a hurry.
 *
 * It must reproduce what k6 ACTUALLY sent, so the construction order mirrors
 * heraBuildRequest in prelude.ts exactly: url interpolation, then query params
 * appended, then headers, then auth (which overwrites Authorization), then the
 * Host override, then the body and its default Content-Type. If those two ever
 * disagree, this command "works" while the run fails and sends everyone chasing
 * the wrong thing.
 *
 * Secrets: values ARE resolved, including secret variables, exactly like the
 * single-step Send curl (executor.ts buildCurl with redact=false). That is the
 * whole point — a masked Authorization header reproduces a 401 that has nothing
 * to do with the one you are debugging. It is therefore built ON DEMAND and
 * never persisted, and the route is gated to the roles that may launch a run.
 *
 * Mirrors backend-go/internal/hera/curl.go — the output is byte-compared by
 * backend/tools/hera-curl-runner.ts against its Go half.
 */

import type { Step } from '../types.js';
import { interpolate } from './target.js';

/** POSIX single-quoting: the only safe way to paste an arbitrary value. */
function q(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export interface StepCurlInput {
  step: Step;
  /** Statically resolvable variables, merged global < suite (buildSeedVars). */
  seedVars: Record<string, string>;
  /** fileId -> filename / mime, for form-data file parts. */
  fileMeta: Record<string, { filename: string; mime: string }>;
  /** Host header override, when the run pinned one. */
  hostHeader?: string;
}

export function buildStepCurl(input: StepCurlInput): string {
  const { step, seedVars } = input;
  const method = (step.request.method || 'GET').toUpperCase();
  const interp = (s: string) => interpolate(s || '', seedVars);

  let url = interp(step.request.url);
  const qs: string[] = [];
  for (const p of step.request.params) {
    if (!p.enabled || !p.key) continue;
    qs.push(encodeURIComponent(interp(p.key)) + '=' + encodeURIComponent(interp(p.value)));
  }
  if (qs.length > 0) url = url + (url.indexOf('?') === -1 ? '?' : '&') + qs.join('&');

  // Insertion order matters: it is what the emitted -H lines follow, and the two
  // languages must agree on it. A Map keeps first-set position on overwrite,
  // matching a JS object's own behaviour in the prelude.
  const headers = new Map<string, string>();
  for (const h of step.request.headers) {
    if (!h.enabled || !h.key) continue;
    headers.set(h.key, interp(h.value));
  }
  const auth = step.request.auth;
  if (auth.type === 'bearer') {
    headers.set('Authorization', 'Bearer ' + interp(auth.token || ''));
  } else if (auth.type === 'basic') {
    const raw = interp(auth.username || '') + ':' + interp(auth.password || '');
    headers.set('Authorization', 'Basic ' + Buffer.from(raw, 'utf8').toString('base64'));
  }
  if (input.hostHeader) headers.set('Host', input.hostHeader);

  const mode = step.request.body.mode;
  const content = step.request.body.content || '';
  const parts = (step.request.body.formData || []).filter((f) => f.enabled && f.key);
  if ((mode === 'json' || mode === 'raw' || mode === 'form') && !headers.has('Content-Type')) {
    if (mode === 'json') headers.set('Content-Type', 'application/json');
    else if (mode === 'form') headers.set('Content-Type', 'application/x-www-form-urlencoded');
  }

  const lines = [`curl -X ${method} ${q(url)}`];
  for (const [k, v] of headers) lines.push(`-H ${q(`${k}: ${v}`)}`);

  if (mode === 'json' || mode === 'raw' || mode === 'form') {
    lines.push(`--data-raw ${q(interp(content))}`);
  } else if (mode === 'form-data') {
    for (const f of parts) {
      const key = interp(f.key);
      if (f.type === 'file') {
        const meta = input.fileMeta[f.fileId] || { filename: 'file', mime: 'application/octet-stream' };
        lines.push(`-F ${q(`${key}=@${meta.filename};type=${meta.mime}`)}`);
      } else {
        lines.push(`-F ${q(`${key}=${interp(f.value)}`)}`);
      }
    }
  }

  // Hera runs with redirects: 0, so a 302 is a result rather than a hop. curl
  // does not follow redirects by default either, so this needs no flag — but say
  // so, because "curl showed 302 and the app works in a browser" is a trap.
  return lines.join(' \\\n  ');
}
