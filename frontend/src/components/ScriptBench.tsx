import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ScriptBenchResult, Step, StepResult, SuiteVariable } from '../types';

/**
 * Script bench — try this step's validation / capture / poll-stop logic against
 * a response you type in, with no HTTP request involved.
 *
 * Why it exists: the alternative is re-sending the real request until an
 * assertion fires, which is slow, needs the service up, and cannot reproduce the
 * cases you most want to assert on — a 500, a malformed body, the third poll
 * attempt. Here the response IS the input.
 *
 * The server runs the SAME functions the real runner uses (visual rules + the
 * sandbox), so a green bench means a green step. Nothing is persisted: even a
 * capture with scope "global" is held in memory for the duration of the call.
 */

type Mode = 'validate' | 'capture' | 'poll';

const MODE_COPY: Record<Mode, { title: string; hint: string }> = {
  validate: {
    title: 'Try validation',
    hint: 'Runs the visual assertions and the validation script against the response below.',
  },
  capture: {
    title: 'Try capture',
    hint: 'Runs the visual captures and the capture script; shows what each variable would be set to.',
  },
  poll: {
    title: 'Try stop condition',
    hint: 'Runs the stop-condition script once. “Would stop” means polling ends on an attempt like this.',
  },
};

interface Props {
  mode: Mode;
  step: Step;
  suiteVars: SuiteVariable[];
  envId: string | null;
  /** Last real Send result for this step, used by “Fill from last response”. */
  lastResult?: StepResult | 'running';
  /**
   * Publishes this bench's run action while the panel is open (null when closed),
   * so the editor's ⌘/Ctrl+Enter can run the bench instead of sending a request.
   * One owner for the shortcut avoids two listeners racing for the same keypress.
   */
  onRunnableChange?: (run: (() => void) | null) => void;
}

export default function ScriptBench({ mode, step, suiteVars, envId, lastResult, onRunnableChange }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(200);
  const [statusText, setStatusText] = useState('OK');
  const [timeMs, setTimeMs] = useState(0);
  const [headersText, setHeadersText] = useState('content-type: application/json');
  const [body, setBody] = useState('{\n  "status": "completed",\n  "token": "abc123"\n}');
  const [result, setResult] = useState<ScriptBenchResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const code = mode === 'validate' ? step.validations.script : mode === 'capture' ? step.captures.script : step.polling?.stopScript ?? '';

  /** One "Name: value" per line — the shape people paste out of curl -i. */
  const parseHeaders = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of headersText.split('\n')) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return out;
  };

  const fillFromLast = () => {
    if (!lastResult || lastResult === 'running' || !lastResult.response) return;
    const r = lastResult.response;
    setStatus(r.status);
    setStatusText(r.statusText);
    setTimeMs(Math.round(r.timeMs));
    setHeadersText(Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n'));
    setBody(r.body);
  };

  const run = async () => {
    setRunning(true);
    setError('');
    try {
      const res = await api.post<ScriptBenchResult>('/api/runs/try-script', {
        mode,
        code,
        visualAssertions: mode === 'validate' ? step.validations.visual : [],
        visualCaptures: mode === 'capture' ? step.captures.visual : [],
        response: { status, statusText, headers: parseHeaders(), timeMs, body },
        suiteVariables: suiteVars,
        envId,
      });
      setResult(res);
    } catch (e: any) {
      setError(e.message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  // Claim (and release) the editor's ⌘/Ctrl+Enter while this panel is open.
  useEffect(() => {
    if (!onRunnableChange) return;
    onRunnableChange(open && !running ? () => void run() : null);
    return () => onRunnableChange(null);
  }, [open, running, onRunnableChange, mode, code, status, statusText, timeMs, headersText, body, envId]);

  const canFill = !!lastResult && lastResult !== 'running' && !!lastResult.response;
  const copy = MODE_COPY[mode];

  if (!open) {
    return (
      <div className="row mt">
        <button className="btn small" onClick={() => setOpen(true)} title={copy.hint}>
          🧪 {copy.title}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>{copy.hint}</span>
      </div>
    );
  }

  return (
    <div className="card mt">
      <div className="row mb">
        <b className="grow">🧪 {copy.title}</b>
        {canFill && <button className="btn small" onClick={fillFromLast} title="Copy the last Send's response into the fields below">
          Fill from last response
        </button>}
        <button className="btn small" onClick={() => setOpen(false)}>Close</button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>{copy.hint} No request is sent and nothing is saved.</p>

      <div className="row mb" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field" style={{ margin: 0 }}>
          <span>Status</span>
          <input type="number" style={{ width: 90 }} value={status} onChange={(e) => setStatus(Number(e.target.value) || 0)} />
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>Status text</span>
          <input type="text" style={{ width: 140 }} value={statusText} onChange={(e) => setStatusText(e.target.value)} />
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>Response time (ms)</span>
          <input type="number" style={{ width: 130 }} value={timeMs} onChange={(e) => setTimeMs(Number(e.target.value) || 0)} />
        </label>
      </div>

      <label className="field">
        <span>Headers — one <span className="mono">Name: value</span> per line</span>
        <textarea className="code" rows={3} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
      </label>

      <label className="field">
        <span>Response body</span>
        <textarea className="code" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>

      <div className="row">
        <button className="btn primary" disabled={running} onClick={() => void run()}
          title="⌘/Ctrl + Enter">
          {running ? 'Running…' : '▶ Run against this response'}
        </button>
        <span className="muted" style={{ fontSize: 11 }}>⌘/Ctrl + Enter</span>
        {!code.trim() && mode !== 'validate' && (
          <span className="muted">This tab has no script yet — the run will only report visual rules.</span>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {result && (
        <div className="mt">
          <div className="row mb" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`role-tag ${result.failed ? 'npc' : ''}`} style={{ color: result.failed ? 'var(--danger)' : 'var(--success)' }}>
              {result.failed ? 'would FAIL' : 'would PASS'}
            </span>
            {result.mode === 'poll' && (
              <span className="muted">{result.stopRequested ? 'stop() called → polling would end here' : 'stop() not called → polling would continue'}</span>
            )}
          </div>

          {result.error && (
            <p className="error-text">
              Script error: {result.error}
            </p>
          )}

          {result.assertions.length > 0 && (
            <table className="list">
              <thead><tr><th style={{ width: 70 }}></th><th>Assertion</th><th>Message</th></tr></thead>
              <tbody>
                {result.assertions.map((a, i) => (
                  <tr key={i}>
                    <td style={{ color: a.passed ? 'var(--success)' : 'var(--danger)' }}>{a.passed ? '✓ pass' : '✕ fail'}</td>
                    <td>{a.name}</td>
                    <td className="muted mono">{a.message || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {result.captured.length > 0 && (
            <>
              <h3 className="mt">Would capture</h3>
              <table className="list">
                <thead><tr><th style={{ width: '30%' }}>Variable</th><th>Value</th><th style={{ width: 90 }}>Scope</th></tr></thead>
                <tbody>
                  {result.captured.map((c, i) => (
                    <tr key={i}>
                      <td className="mono">{`{{${c.key}}}`}</td>
                      <td className="mono">{c.value}</td>
                      <td className="muted">{c.scope}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">Not saved — a real run is what writes these.</p>
            </>
          )}

          {result.usedVariables.length > 0 && (
            <>
              <h3 className="mt">Variables read by the script</h3>
              <table className="list">
                <thead><tr><th style={{ width: '30%' }}>Name</th><th>Resolved value</th></tr></thead>
                <tbody>
                  {result.usedVariables.map((v) => (
                    <tr key={v.key}>
                      <td className="mono">{v.key}</td>
                      <td className="mono">{v.value === '' ? <span className="muted">(undefined)</span> : v.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {result.logs.length > 0 && (
            <>
              <h3 className="mt">console.log</h3>
              <pre className="code">{result.logs.join('\n')}</pre>
            </>
          )}

          {result.assertions.length === 0 && result.captured.length === 0 && !result.error && (
            <p className="muted">Nothing to report — no assertions, captures or errors for this response.</p>
          )}
        </div>
      )}
    </div>
  );
}
