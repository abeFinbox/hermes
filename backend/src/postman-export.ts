import type { Assertion, CaptureRule, Step, Suite } from './types.js';
import { describeAssertion } from './runner/executor.js';

/**
 * Suite → Postman Collection v2.1 exporter (the reverse of postman.ts).
 * - Folder structure is rebuilt from each step's folderPath.
 * - Original pm scripts preserved at import time are re-attached verbatim.
 * - Otherwise, visual assertions/captures are translated into a pm test
 *   script; sandbox-mode scripts are included as comments (their API is not
 *   pm-compatible) so nothing is silently lost.
 */

const J = JSON.stringify;

/** "$.data.token" / "$.items[0].id" → "pm.response.json().data.token" (simple paths only) */
function jsonAccessor(expr: string): string | null {
  const m = /^\$((?:\.[A-Za-z_$][\w$]*|\[\d+\])+)$/.exec((expr || '').trim());
  return m ? `pm.response.json()${m[1]}` : null;
}

function assertionLines(a: Assertion): string[] {
  const name = J(describeAssertion(a));
  switch (a.type) {
    case 'status-equals':
      return [`pm.test(${name}, function () { pm.response.to.have.status(${Number(a.expected) || 0}); });`];
    case 'body-contains':
      return [`pm.test(${name}, function () { pm.expect(pm.response.text()).to.include(${J(a.expected || '')}); });`];
    case 'header-equals':
      return [`pm.test(${name}, function () { pm.expect(pm.response.headers.get(${J(a.expression || '')})).to.eql(${J(a.expected || '')}); });`];
    case 'response-time-below':
      return [`pm.test(${name}, function () { pm.expect(pm.response.responseTime).to.be.below(${Number(a.expected) || 0}); });`];
    case 'jsonpath-exists': {
      const acc = jsonAccessor(a.expression || '');
      if (!acc) return [`// skipped (complex JSONPath): ${describeAssertion(a)}`];
      return [`pm.test(${name}, function () { pm.expect(${acc}).to.not.eql(undefined); });`];
    }
    case 'jsonpath-equals': {
      const acc = jsonAccessor(a.expression || '');
      if (!acc) return [`// skipped (complex JSONPath): ${describeAssertion(a)}`];
      return [`pm.test(${name}, function () { pm.expect(String(${acc})).to.eql(${J(a.expected || '')}); });`];
    }
    default:
      return [];
  }
}

function captureLines(c: CaptureRule): string[] {
  if (!c.targetVariable) return [];
  const set = (value: string) => `pm.collectionVariables.set(${J(c.targetVariable)}, ${value});`;
  switch (c.source) {
    case 'status': return [set('String(pm.response.code)')];
    case 'header': return [set(`pm.response.headers.get(${J(c.expression || '')})`)];
    case 'body-text': return [set('pm.response.text()')];
    case 'body-jsonpath': {
      const acc = jsonAccessor(c.expression || '');
      if (!acc) return [`// skipped capture (complex JSONPath ${J(c.expression)}) -> {{${c.targetVariable}}}`];
      return [set(acc)];
    }
    default: return [];
  }
}

function commentBlock(title: string, code: string): string[] {
  return [
    `// --- ${title} (Hermes sandbox script, not pm-compatible — for reference) ---`,
    ...code.split('\n').map((l) => `// ${l}`),
  ];
}

function buildEvents(step: Step): unknown[] | undefined {
  // originals win: they were preserved verbatim at import time
  if (Array.isArray(step.postmanEvents) && step.postmanEvents.length) return step.postmanEvents;

  const lines: string[] = [];
  for (const a of step.validations.visual) lines.push(...assertionLines(a));
  for (const c of step.captures.visual) lines.push(...captureLines(c));
  if (step.validations.script?.trim()) lines.push(...commentBlock('validation script', step.validations.script));
  if (step.captures.script?.trim()) lines.push(...commentBlock('capture script', step.captures.script));

  if (!lines.length) return undefined;
  return [{ listen: 'test', script: { type: 'text/javascript', exec: lines } }];
}

function buildRequest(step: Step): Record<string, unknown> {
  const r = step.request;
  const request: Record<string, unknown> = { method: r.method };

  const enabledParams = r.params.filter((p) => p.key);
  if (enabledParams.length) {
    const qs = enabledParams.filter((p) => p.enabled).map((p) => `${p.key}=${p.value}`).join('&');
    const raw = qs ? `${r.url}${r.url.includes('?') ? '&' : '?'}${qs}` : r.url;
    request.url = {
      raw,
      query: enabledParams.map((p) => ({ key: p.key, value: p.value, disabled: !p.enabled || undefined })),
    };
  } else {
    request.url = r.url;
  }

  if (r.headers.length) {
    request.header = r.headers
      .filter((h) => h.key)
      .map((h) => ({ key: h.key, value: h.value, disabled: !h.enabled || undefined }));
  }

  if (r.body.mode === 'json' || r.body.mode === 'raw') {
    request.body = {
      mode: 'raw',
      raw: r.body.content,
      options: r.body.mode === 'json' ? { raw: { language: 'json' } } : undefined,
    };
  } else if (r.body.mode === 'form') {
    request.body = {
      mode: 'urlencoded',
      urlencoded: r.body.content
        .split('&')
        .filter(Boolean)
        .map((pair) => {
          const [k, ...rest] = pair.split('=');
          return { key: safeDecode(k), value: safeDecode(rest.join('=')) };
        }),
    };
  } else if (r.body.mode === 'form-data') {
    // Postman collections can't carry file bytes; file parts export as file placeholders (src null).
    request.body = {
      mode: 'formdata',
      formdata: (r.body.formData || [])
        .filter((f) => f.key)
        .map((f) =>
          f.type === 'file'
            ? { key: f.key, type: 'file', src: null, disabled: !f.enabled || undefined }
            : { key: f.key, type: 'text', value: f.value, disabled: !f.enabled || undefined },
        ),
    };
  }

  if (r.auth.type === 'bearer') {
    request.auth = { type: 'bearer', bearer: [{ key: 'token', value: r.auth.token, type: 'string' }] };
  } else if (r.auth.type === 'basic') {
    request.auth = {
      type: 'basic',
      basic: [
        { key: 'username', value: r.auth.username, type: 'string' },
        { key: 'password', value: r.auth.password, type: 'string' },
      ],
    };
  }

  return request;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function exportSuiteAsCollection(suite: Suite): Record<string, unknown> {
  const root: unknown[] = [];
  const folderChildren = new Map<string, unknown[]>();

  const childrenFor = (path: string): unknown[] => {
    if (!path) return root;
    const existing = folderChildren.get(path);
    if (existing) return existing;
    const parts = path.split(' / ');
    const parent = childrenFor(parts.slice(0, -1).join(' / '));
    const folder = { name: parts[parts.length - 1], item: [] as unknown[] };
    parent.push(folder);
    folderChildren.set(path, folder.item);
    return folder.item;
  };

  for (const step of suite.steps) {
    const item: Record<string, unknown> = { name: step.name, request: buildRequest(step) };
    const events = buildEvents(step);
    if (events) item.event = events;
    childrenFor(step.folderPath || '').push(item);
  }

  return {
    info: {
      _postman_id: suite.id,
      name: suite.name,
      description: suite.description || undefined,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    // secret values are masked in the export — fill them in after importing
    variable: suite.variables.map((v) => ({ key: v.key, value: v.secret ? '' : v.value })),
    item: root,
  };
}
