import { useEffect, useState } from 'react';
import type { Assertion, AssertionType, CaptureRule, FormDataField, GlobalVariable, Step, StepPolling, StoredFile, SuiteVariable } from '../types';
import { newId, defaultPolling } from '../types';
import { api } from '../api';
import { Info } from '../legends';
import { formatBytes } from '../pages/Files';
import KVEditor from './KVEditor';
import VarChips from './VarChips';

interface TabProps {
  step: Step;
  stepIndex: number;
  steps: Step[];
  suiteVars: SuiteVariable[];
  globals: GlobalVariable[];
  onChange: (patch: Partial<Step>) => void;
  onGlobalsChanged: () => void;
}

// ---------------- Request tab ----------------

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function RequestTab({ step, stepIndex, steps, suiteVars, globals, onChange, onGlobalsChanged }: TabProps) {
  const req = step.request;
  const setReq = (patch: Partial<Step['request']>) => onChange({ request: { ...req, ...patch } });

  return (
    <div>
      <div className="row mb">
        <select style={{ width: 110 }} value={req.method} onChange={(e) => setReq({ method: e.target.value })}>
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input className="grow mono" type="text" placeholder="https://api.example.com/path or {{baseUrl}}/path"
          value={req.url} onChange={(e) => setReq({ url: e.target.value })} />
      </div>

      <VarChips step={step} stepIndex={stepIndex} steps={steps} suiteVars={suiteVars} globals={globals} onGlobalsChanged={onGlobalsChanged} />

      <h3 className="mt">Query params</h3>
      <KVEditor items={req.params} onChange={(params) => setReq({ params })} keyPlaceholder="param" />

      <h3 className="mt">Headers</h3>
      <KVEditor items={req.headers} onChange={(headers) => setReq({ headers })} keyPlaceholder="Header-Name" />

      <h3 className="mt">Body<Info k="body.formdata" /></h3>
      <div className="row mb">
        <select style={{ width: 160 }} value={req.body.mode} onChange={(e) => {
          const mode = e.target.value as Step['request']['body']['mode'];
          setReq({ body: { ...req.body, mode, formData: mode === 'form-data' ? (req.body.formData ?? []) : req.body.formData } });
        }}>
          <option value="none">none</option>
          <option value="json">JSON</option>
          <option value="raw">raw text</option>
          <option value="form">form-urlencoded</option>
          <option value="form-data">form-data (files)</option>
        </select>
        {req.body.mode === 'form' && <span className="muted">key=value&key2=value2</span>}
        {req.body.mode === 'form-data' && <span className="muted">multipart — text fields + file uploads</span>}
      </div>
      {req.body.mode !== 'none' && (req.method === 'GET' || req.method === 'HEAD') && (
        <label className="row mb" style={{ gap: 6 }}>
          <input type="checkbox" checked={!!req.body.sendWithGet}
            onChange={(e) => setReq({ body: { ...req.body, sendWithGet: e.target.checked } })} />
          <span className="muted">Send this body with the {req.method} request (unusual, but some APIs require it)</span>
        </label>
      )}
      {(req.body.mode === 'json' || req.body.mode === 'raw' || req.body.mode === 'form') && (
        <textarea className="code" rows={8} value={req.body.content} onChange={(e) => setReq({ body: { ...req.body, content: e.target.value } })} />
      )}
      {req.body.mode === 'form-data' && (
        <FormDataEditor fields={req.body.formData ?? []} onChange={(formData) => setReq({ body: { ...req.body, formData } })} />
      )}

      <h3 className="mt">Auth</h3>
      <div className="row mb">
        <select style={{ width: 160 }} value={req.auth.type} onChange={(e) => {
          const t = e.target.value;
          setReq({ auth: t === 'bearer' ? { type: 'bearer', token: '' } : t === 'basic' ? { type: 'basic', username: '', password: '' } : { type: 'none' } });
        }}>
          <option value="none">none / inherit from headers</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic auth</option>
        </select>
        {req.auth.type === 'bearer' && (
          <input className="grow mono" type="text" placeholder="{{authToken}}" value={req.auth.token}
            onChange={(e) => setReq({ auth: { type: 'bearer', token: e.target.value } })} />
        )}
        {req.auth.type === 'basic' && (() => {
          const auth = req.auth;
          return (
            <>
              <input className="grow" type="text" placeholder="username" value={auth.username}
                onChange={(e) => setReq({ auth: { ...auth, username: e.target.value } })} />
              <input className="grow" type="text" placeholder="password or {{var}}" value={auth.password}
                onChange={(e) => setReq({ auth: { ...auth, password: e.target.value } })} />
            </>
          );
        })()}
      </div>

      {step.sourceRequest && (
        <button className="btn small mt" title="Restore the request exactly as it was imported from Postman"
          onClick={() => onChange({ request: JSON.parse(JSON.stringify(step.sourceRequest)) })}>
          ↩ Reset to imported original<Info k="step.reset" />
        </button>
      )}
    </div>
  );
}

// ---------------- form-data (multipart) body editor ----------------

function FormDataEditor({ fields, onChange }: { fields: FormDataField[]; onChange: (f: FormDataField[]) => void }) {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loadErr, setLoadErr] = useState('');

  const loadFiles = () =>
    api.get<StoredFile[]>('/api/files').then((f) => { setFiles(f); setLoadErr(''); }).catch((e) => setLoadErr(e.message));
  useEffect(() => { void loadFiles(); }, []);

  const update = (i: number, patch: Partial<FormDataField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const add = (type: 'text' | 'file') =>
    onChange([...fields, { id: newId(), key: '', type, value: '', fileId: '', enabled: true }]);
  const remove = (i: number) => onChange(fields.filter((_, j) => j !== i));

  return (
    <div>
      {fields.map((f, i) => {
        const missing = f.type === 'file' && !!f.fileId && !files.some((s) => s.id === f.fileId);
        // an enabled file field with no valid store file will fail on send
        const needsFile = f.type === 'file' && f.enabled && (!f.fileId || missing);
        return (
          <div key={f.id}>
            <div className="row mb" style={{ marginBottom: needsFile ? 2 : undefined }}>
              <input type="checkbox" checked={f.enabled} title="include this field" onChange={(e) => update(i, { enabled: e.target.checked })} />
              <input style={{ width: 170 }} type="text" placeholder="field name" value={f.key} onChange={(e) => update(i, { key: e.target.value })} />
              <select style={{ width: 90 }} value={f.type} onChange={(e) => update(i, { type: e.target.value as 'text' | 'file' })}>
                <option value="text">text</option>
                <option value="file">file</option>
              </select>
              {f.type === 'text' ? (
                <input className="grow mono" type="text" placeholder="value or {{var}}" value={f.value} onChange={(e) => update(i, { value: e.target.value })} />
              ) : (
                <select className="grow mono" value={f.fileId} onChange={(e) => update(i, { fileId: e.target.value })} style={needsFile ? { borderColor: 'var(--danger)' } : undefined}>
                  <option value="">— choose a file —</option>
                  {missing && <option value={f.fileId}>⚠ missing (deleted) file — re-select below</option>}
                  {files.map((s) => <option key={s.id} value={s.id}>{s.originalName} ({formatBytes(s.size)})</option>)}
                </select>
              )}
              <button className="btn icon danger" onClick={() => remove(i)}>✕</button>
            </div>
            {needsFile && (
              <div className="error-text mb" style={{ marginLeft: 28 }}>
                {missing ? 'The chosen file is no longer in the store — pick it again from the dropdown.' : 'Pick a file for this field, or it will fail when sent.'}
              </div>
            )}
          </div>
        );
      })}
      <div className="row">
        <button className="btn small" onClick={() => add('text')}>+ Text field</button>
        <button className="btn small" onClick={() => add('file')}>+ File field</button>
        <button className="btn small" onClick={() => void loadFiles()} title="refresh the file list">↻ Refresh files</button>
        <a className="btn small" href="/files" target="_blank" rel="noreferrer">Manage files ↗</a>
      </div>
      {loadErr && <p className="muted" style={{ color: 'var(--danger)' }}>Couldn't load files: {loadErr}</p>}
      {!loadErr && files.length === 0 && (
        <p className="muted">No files uploaded yet. Add them on the <a href="/files" target="_blank" rel="noreferrer">Files</a> page, then pick one here.</p>
      )}
    </div>
  );
}

// ---------------- Validate tab ----------------

const ASSERTION_TYPES: Array<{ value: AssertionType; label: string; needsExpression: boolean; needsExpected: boolean }> = [
  { value: 'status-equals', label: 'Status code equals', needsExpression: false, needsExpected: true },
  { value: 'jsonpath-exists', label: 'JSONPath exists', needsExpression: true, needsExpected: false },
  { value: 'jsonpath-equals', label: 'JSONPath equals', needsExpression: true, needsExpected: true },
  { value: 'header-equals', label: 'Header equals', needsExpression: true, needsExpected: true },
  { value: 'body-contains', label: 'Body contains text', needsExpression: false, needsExpected: true },
  { value: 'response-time-below', label: 'Response time below (ms)', needsExpression: false, needsExpected: true },
];

const VALIDATE_PLACEHOLDER = `// Runs after the response. Each test() becomes a report line.
test("status is 200", () => {
  expect(response.status).toBe(200);
});
test("has a token", () => {
  expect(response.json().token).toBeDefined();
});
// also available: variables.get("name"), response.time, response.headers`;

export function ValidateTab({ step, onChange }: TabProps) {
  const v = step.validations;
  const setV = (patch: Partial<Step['validations']>) => onChange({ validations: { ...v, ...patch } });
  const update = (i: number, patch: Partial<Assertion>) => setV({ visual: v.visual.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  return (
    <div>
      <h3>Visual assertions</h3>
      {v.visual.map((a, i) => {
        const spec = ASSERTION_TYPES.find((t) => t.value === a.type)!;
        return (
          <div className="row mb" key={a.id}>
            <select style={{ width: 210 }} value={a.type} onChange={(e) => update(i, { type: e.target.value as AssertionType })}>
              {ASSERTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            {spec.needsExpression && (
              <input className="grow mono" type="text" value={a.expression || ''} onChange={(e) => update(i, { expression: e.target.value })}
                placeholder={a.type.startsWith('jsonpath') ? '$.data.token' : 'Header-Name'} />
            )}
            {spec.needsExpected && (
              <input className="grow mono" type="text" value={a.expected || ''} onChange={(e) => update(i, { expected: e.target.value })}
                placeholder={a.type === 'status-equals' ? '200' : a.type === 'response-time-below' ? '1500' : 'expected value'} />
            )}
            <button className="btn icon danger" onClick={() => setV({ visual: v.visual.filter((_, j) => j !== i) })}>✕</button>
          </div>
        );
      })}
      <button className="btn small" onClick={() => setV({ visual: [...v.visual, { id: newId(), type: 'status-equals', expected: '200' }] })}>
        + Add assertion
      </button>

      <h3 className="mt">Validation script<Info k="validate.script" /></h3>
      <textarea className="code" rows={10} placeholder={VALIDATE_PLACEHOLDER} value={v.script}
        onChange={(e) => setV({ script: e.target.value })} />
      <p className="muted">
        Sandboxed JavaScript. API: <span className="mono">test(name, fn)</span>, <span className="mono">expect(v).toBe/.toEqual/.toContain/.toMatch/.toBeLessThan/.toBeGreaterThan/.toBeDefined</span>,{' '}
        <span className="mono">response.status/.json()/.text()/.headers/.time</span>, <span className="mono">variables.get()</span>, <span className="mono">console.log()</span>.
      </p>
    </div>
  );
}

// ---------------- Capture tab ----------------

const CAPTURE_PLACEHOLDER = `// Runs after the response. Set variables for LATER steps.
const body = response.json();
variables.set("authToken", body.token);            // suite scope
variables.set("userId", body.user.id, "global");   // persisted global
console.log("captured", body.token);`;

export function CaptureTab({ step, onChange }: TabProps) {
  const c = step.captures;
  const setC = (patch: Partial<Step['captures']>) => onChange({ captures: { ...c, ...patch } });
  const update = (i: number, patch: Partial<CaptureRule>) => setC({ visual: c.visual.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  return (
    <div>
      <p className="muted">
        Captures pull values out of <b>this step's response</b> into variables, which later steps can use as{' '}
        <span className="mono">{'{{variable}}'}</span> — this is how you chain APIs.
      </p>

      <h3>Visual captures</h3>
      {c.visual.map((r, i) => (
        <div className="row mb" key={r.id}>
          <select style={{ width: 160 }} value={r.source} onChange={(e) => update(i, { source: e.target.value as CaptureRule['source'] })}>
            <option value="body-jsonpath">Body JSONPath</option>
            <option value="header">Header</option>
            <option value="status">Status code</option>
            <option value="body-text">Whole body</option>
          </select>
          {(r.source === 'body-jsonpath' || r.source === 'header') && (
            <input className="grow mono" type="text" value={r.expression}
              placeholder={r.source === 'header' ? 'Header-Name' : '$.data.token'}
              onChange={(e) => update(i, { expression: e.target.value })} />
          )}
          <span className="muted">→</span>
          <input style={{ width: 170 }} className="mono" type="text" value={r.targetVariable} placeholder="variableName"
            onChange={(e) => update(i, { targetVariable: e.target.value })} />
          <select style={{ width: 110 }} value={r.scope} onChange={(e) => update(i, { scope: e.target.value as 'suite' | 'global' })}
            title="suite: lives for this run + suite vars. global: persisted for all suites.">
            <option value="suite">suite</option>
            <option value="global">global</option>
          </select>
          <Info k="step.captureScope" />
          <button className="btn icon danger" onClick={() => setC({ visual: c.visual.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <button className="btn small" onClick={() => setC({ visual: [...c.visual, { id: newId(), source: 'body-jsonpath', expression: '', targetVariable: '', scope: 'suite' }] })}>
        + Add capture
      </button>

      <h3 className="mt">Capture script<Info k="capture.script" /></h3>
      <textarea className="code" rows={10} placeholder={CAPTURE_PLACEHOLDER} value={c.script}
        onChange={(e) => setC({ script: e.target.value })} />
      <p className="muted">
        Sandboxed JavaScript. API: <span className="mono">variables.set(name, value[, "global"])</span>,{' '}
        <span className="mono">variables.get()</span>, <span className="mono">response.*</span>, <span className="mono">console.log()</span>, <span className="mono">fail(msg)</span>.
      </p>
    </div>
  );
}

// ---------------- Poll tab ----------------

const POLL_PLACEHOLDER = `// runs after every attempt — call stop() when done
if (response.json().status === 'completed') stop();`;

export function PollTab({ step, onChange }: TabProps) {
  const p = step.polling ?? defaultPolling();
  const setP = (patch: Partial<StepPolling>) => onChange({ polling: { ...p, ...patch } });

  return (
    <div>
      <p className="muted">
        Polling re-sends this request on an interval <b>until your stop condition is met</b> — or the timeout elapses,
        which fails the step. Handy for async work: poll a status endpoint until the job is done.
      </p>

      <label className="row mb" style={{ gap: 6, cursor: 'pointer' }}>
        <input type="checkbox" checked={p.enabled} onChange={(e) => setP({ enabled: e.target.checked })} />
        <b>Poll this request</b>
      </label>

      <div className="row mb" style={{ gap: 16, alignItems: 'flex-end' }}>
        <label className="field" style={{ margin: 0 }}>
          <span>Interval (ms)</span>
          <input type="number" min={250} step={250} style={{ width: 120 }} value={p.intervalMs} disabled={!p.enabled}
            onChange={(e) => setP({ intervalMs: Number(e.target.value) || 0 })} />
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>Timeout (ms)</span>
          <input type="number" min={1000} step={1000} style={{ width: 140 }} value={p.timeoutMs} disabled={!p.enabled}
            onChange={(e) => setP({ timeoutMs: Number(e.target.value) || 0 })} />
        </label>
      </div>

      <h3>Stop condition script</h3>
      <textarea className="code" rows={8} placeholder={POLL_PLACEHOLDER} value={p.stopScript} disabled={!p.enabled}
        onChange={(e) => setP({ stopScript: e.target.value })} />
      <p className="muted">
        Sandboxed JavaScript, run after each attempt. Call <span className="mono">stop()</span> when the success condition is met.
        API: <span className="mono">response.*</span>, <span className="mono">variables.get()</span>, <span className="mono">console.log()</span>.
      </p>
    </div>
  );
}
