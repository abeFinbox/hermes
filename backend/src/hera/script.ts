import { HERA_PRELUDE } from './prelude.js';
import type { Step, Suite } from '../types.js';

/**
 * Suite -> k6 script generator.
 *
 * The output is the parity surface: backend-go/internal/hera/script.go must
 * produce BYTE-IDENTICAL text for the same input, and the fixture harness diffs
 * them. Determinism rules that make that possible:
 *
 *   1. no timestamps, UUIDs or randomness — a run id arrives as __ENV.HERA_RUN_ID
 *   2. every map-like collection is emitted in a sorted, explicit order (Go map
 *      iteration is deliberately randomised)
 *   3. string literals go through jsLiteral() below, not the language's JSON
 *      encoder — Go escapes <, > and & where JSON.stringify does not
 *   4. numbers are emitted via intLiteral(), never a language float formatter
 */

export interface HeraLoadConfig {
  vus: number;
  durationSec: number;
  rps: number;
  thinkTimeMs: number;
  /** null disables the threshold. */
  p95Ms: number | null;
  errorRatePct: number | null;
}

export interface HeraStepMeta {
  stepId: string;
  tag: string;
  name: string;
  method: string;
  url: string;
}

export interface GenerateInput {
  suite: Suite;
  /** Statically resolvable variables, already merged (global < suite). */
  seedVars: Record<string, string>;
  load: HeraLoadConfig;
  /** fileId -> absolute path on this host, for form-data file parts. */
  filePaths: Record<string, string>;
  /** fileId -> original filename / mime, for the multipart part. */
  fileMeta: Record<string, { filename: string; mime: string }>;
  /** Optional Host header override per step url host, from resolve-then-pin. */
  hostHeader?: string;
  /**
   * Per-step resolve-then-pin. The url has its ORIGIN replaced by the literal
   * resolved IP (path and query keep their {{tokens}}), and hostHeader carries
   * the original hostname — so k6 never performs its own lookup and cannot be
   * rebound between validation and execution. Keyed by step id, because one
   * suite can span several origins.
   */
  pins?: Record<string, { url: string; hostHeader: string }>;
}

export interface GenerateResult {
  script: string;
  steps: HeraStepMeta[];
}

/**
 * Deterministic JS string literal. Deliberately not JSON.stringify: Go's
 * encoder escapes <, > and & as < etc. even with SetEscapeHTML(false) off
 * for some paths, and the two languages disagree on U+2028/U+2029. Hand-rolling
 * it removes the whole class of divergence.
 */
export function jsLiteral(s: string): string {
  let out = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c < 0x20 || c === 0x7f) out += '\\u' + c.toString(16).padStart(4, '0');
    else if (c === 0x2028) out += '\\u2028';
    else if (c === 0x2029) out += '\\u2029';
    else out += ch;
  }
  return out + '"';
}

function intLiteral(n: number): string {
  return String(Math.trunc(Number.isFinite(n) ? n : 0));
}

function boolLiteral(b: boolean): string {
  return b ? 'true' : 'false';
}

/**
 * Integer percent -> a fixed-decimal rate literal, by integer math only.
 * Neither language's float formatter is involved, because they disagree
 * (0.025 vs 2.5e-02) and the output has to be byte-identical.
 */
export function percentLiteral(pct: number): string {
  const p = Math.max(0, Math.min(100, Math.trunc(pct)));
  if (p === 100) return '1';
  return '0.' + String(p).padStart(2, '0');
}

/** s01, s02, ... — stable, unique, and safe inside a k6 threshold selector. */
export function stepTag(index: number): string {
  return 's' + String(index + 1).padStart(2, '0');
}

function enabledSteps(suite: Suite): Step[] {
  return suite.steps.filter((s) => s.enabled);
}

export function stepMetas(suite: Suite): HeraStepMeta[] {
  return enabledSteps(suite).map((s, i) => ({
    stepId: s.id,
    tag: stepTag(i),
    name: s.name,
    method: (s.request.method || 'GET').toUpperCase(),
    url: s.request.url,
  }));
}

function emitStepDef(step: Step, meta: HeraStepMeta, input: GenerateInput): string {
  const pin = input.pins?.[step.id];
  const L: string[] = [];
  L.push('  {');
  L.push('    stepId: ' + jsLiteral(meta.stepId) + ',');
  L.push('    tag: ' + jsLiteral(meta.tag) + ',');
  L.push('    name: ' + jsLiteral(meta.name) + ',');
  L.push('    method: ' + jsLiteral(meta.method) + ',');
  L.push('    url: ' + jsLiteral(pin ? pin.url : step.request.url) + ',');

  const headers = step.request.headers.filter((h) => h.enabled && h.key);
  L.push(
    '    headers: [' +
      headers.map((h) => '[' + jsLiteral(h.key) + ', ' + jsLiteral(h.value) + ']').join(', ') +
      '],',
  );

  const params = step.request.params.filter((p) => p.enabled && p.key);
  L.push(
    '    params: [' +
      params.map((p) => '[' + jsLiteral(p.key) + ', ' + jsLiteral(p.value) + ']').join(', ') +
      '],',
  );

  L.push('    bodyMode: ' + jsLiteral(step.request.body.mode) + ',');
  L.push('    body: ' + jsLiteral(step.request.body.content || '') + ',');

  const parts = (step.request.body.formData || []).filter((f) => f.enabled && f.key);
  L.push(
    '    formData: [' +
      parts
        .map((f) => {
          if (f.type === 'file') {
            const meta2 = input.fileMeta[f.fileId] || { filename: 'file', mime: 'application/octet-stream' };
            return (
              '{ kind: "file", key: ' +
              jsLiteral(f.key) +
              ', fileId: ' +
              jsLiteral(f.fileId) +
              ', filename: ' +
              jsLiteral(meta2.filename) +
              ', mime: ' +
              jsLiteral(meta2.mime) +
              ' }'
            );
          }
          return '{ kind: "text", key: ' + jsLiteral(f.key) + ', value: ' + jsLiteral(f.value) + ' }';
        })
        .join(', ') +
      '],',
  );

  const auth = step.request.auth;
  if (auth.type === 'bearer') {
    L.push('    auth: { type: "bearer", token: ' + jsLiteral(auth.token) + ' },');
  } else if (auth.type === 'basic') {
    L.push(
      '    auth: { type: "basic", username: ' +
        jsLiteral(auth.username) +
        ', password: ' +
        jsLiteral(auth.password) +
        ' },',
    );
  } else {
    L.push('    auth: { type: "none" },');
  }

  L.push(
    '    assertions: [' +
      step.validations.visual
        .map(
          (a) =>
            '{ type: ' +
            jsLiteral(a.type) +
            ', expression: ' +
            jsLiteral(a.expression || '') +
            ', expected: ' +
            jsLiteral(a.expected || '') +
            ' }',
        )
        .join(', ') +
      '],',
  );

  L.push(
    '    captures: [' +
      step.captures.visual
        .map(
          (c) =>
            '{ source: ' +
            jsLiteral(c.source) +
            ', expression: ' +
            jsLiteral(c.expression || '') +
            ', target: ' +
            jsLiteral(c.targetVariable) +
            ', scope: ' +
            jsLiteral(c.scope) +
            ' }',
        )
        .join(', ') +
      '],',
  );

  L.push('    validateScript: ' + jsLiteral(step.validations.script || '') + ',');
  L.push('    captureScript: ' + jsLiteral(step.captures.script || '') + ',');

  const p = step.polling;
  if (p && p.enabled) {
    L.push(
      '    polling: { enabled: true, intervalMs: ' +
        intLiteral(p.intervalMs) +
        ', timeoutMs: ' +
        intLiteral(p.timeoutMs) +
        ', stopScript: ' +
        jsLiteral(p.stopScript || '') +
        ' },',
    );
  } else {
    L.push('    polling: null,');
  }

  const hostHeader = pin ? pin.hostHeader : input.hostHeader;
  if (hostHeader) {
    L.push('    hostHeader: ' + jsLiteral(hostHeader) + ',');
  } else {
    L.push('    hostHeader: null,');
  }
  L.push('  }');
  return L.join('\n');
}

export function generateScript(input: GenerateInput): GenerateResult {
  const { suite, load } = input;
  const steps = enabledSteps(suite);
  const metas = stepMetas(suite);
  const L: string[] = [];

  L.push('// Generated by Hermes / Hera — do not edit.');
  L.push('// One iteration = the whole suite, chained, walked by one virtual user.');
  L.push('// Suite: ' + suite.name.replace(/[\r\n]+/g, ' '));
  L.push('');
  L.push("import http from 'k6/http';");
  L.push("import { check, group, sleep } from 'k6';");
  L.push("import { Counter, Trend } from 'k6/metrics';");
  L.push("import { b64encode } from 'k6/encoding';");
  L.push('');

  // Metrics. hera_script_errors carries a count==0 threshold because a thrown
  // exception in a VU exits 0 — the exit code alone can never be the verdict.
  L.push("var heraScriptErrors = new Counter('hera_script_errors');");
  L.push("var heraGlobalWrites = new Counter('hera_suppressed_global_writes');");
  L.push("var heraPollAttempts = new Trend('hera_poll_attempts');");
  L.push("var heraPollWaitMs = new Trend('hera_poll_wait_ms', true);");
  L.push('');

  // Runtime knobs the prelude reads.
  L.push('var HERA_STOP_ON_FAILURE = ' + boolLiteral(suite.settings.stopOnFailure) + ';');
  L.push('var HERA_RUN_CAPTURES_ON_FAILURE = ' + boolLiteral(suite.settings.runCapturesOnFailure) + ';');
  L.push('var HERA_THINK_TIME_MS = ' + intLiteral(load.thinkTimeMs) + ';');
  L.push('');

  // Files opened at init scope — k6 requires open() there. The bytes already
  // live in the managed file store, so nothing new is written to disk.
  const fileIds = Object.keys(input.filePaths).sort();
  if (fileIds.length > 0) {
    L.push('var HERA_FILES = {');
    for (const id of fileIds) {
      L.push('  ' + jsLiteral(id) + ': open(' + jsLiteral(input.filePaths[id]) + ", 'b'),");
    }
    L.push('};');
  } else {
    L.push('var HERA_FILES = {};');
  }
  L.push('');

  // Seed variables as sorted pairs, so both languages emit the same order.
  const seedKeys = Object.keys(input.seedVars).sort();
  L.push('var HERA_SEED = [');
  for (const k of seedKeys) {
    L.push('  [' + jsLiteral(k) + ', ' + jsLiteral(input.seedVars[k]) + '],');
  }
  L.push('];');
  L.push('');

  L.push('var HERA_STEPS = [');
  L.push(steps.map((s, i) => emitStepDef(s, metas[i], input)).join(',\n'));
  L.push('];');
  L.push('');

  // Thresholds. Per-step sub-metrics only appear in the summary when a threshold
  // names them, so each step gets always-true thresholds purely to surface its
  // numbers. The real pass/fail thresholds come after.
  const thresholds: string[] = [];
  thresholds.push("  'hera_script_errors': ['count==0'],");
  for (const m of metas) {
    const sel = '{hera_step:' + m.tag + '}';
    thresholds.push("  'http_req_duration" + sel + "': ['max>=0'],");
    thresholds.push("  'http_req_failed" + sel + "': ['rate>=0'],");
    thresholds.push("  'http_reqs" + sel + "': ['count>=0'],");
    // Without this the per-step script-error count is always reported as 0,
    // because a tagged sub-metric only reaches the summary if a threshold
    // names it — and then you cannot tell WHICH step's script is broken.
    thresholds.push("  'hera_script_errors" + sel + "': ['count>=0'],");
  }
  for (let i = 0; i < steps.length; i++) {
    const p = steps[i].polling;
    if (p && p.enabled) {
      const sel = '{hera_step:' + metas[i].tag + '}';
      thresholds.push("  'hera_poll_attempts" + sel + "': ['max>=0'],");
      thresholds.push("  'hera_poll_wait_ms" + sel + "': ['max>=0'],");
    }
  }
  if (load.p95Ms !== null) {
    thresholds.push("  'http_req_duration': ['p(95)<" + intLiteral(load.p95Ms) + "'],");
  }
  if (load.errorRatePct !== null) {
    thresholds.push("  'http_req_failed': ['rate<" + percentLiteral(load.errorRatePct) + "'],");
  }

  L.push('export var options = {');
  L.push('  vus: ' + intLiteral(load.vus) + ',');
  L.push("  duration: '" + intLiteral(load.durationSec) + "s',");
  L.push('  rps: ' + intLiteral(load.rps) + ',');
  L.push('  maxRedirects: 0,');
  L.push("  summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],");
  L.push('  thresholds: {');
  L.push(thresholds.join('\n'));
  L.push('  },');
  L.push('};');

  L.push(HERA_PRELUDE);

  return { script: L.join('\n'), steps: metas };
}
