import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Info } from '../legends';
import { Modal, useToast } from '../ui';
import type { Run, StepResult } from '../types';

export default function RunDetail() {
  const { id } = useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [report, setReport] = useState<object | null>(null);
  const [stopping, setStopping] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = async () => {
      try {
        const r = await api.get<Run>(`/api/runs/${id}`);
        setRun(r);
        if (r.status !== 'running' && timer) clearInterval(timer);
      } catch (e: any) {
        toast(e.message, 'error');
        if (timer) clearInterval(timer);
      }
    };
    void load();
    timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, [id]);

  if (!run) return <div className="muted">Loading…</div>;

  const stop = async () => {
    setStopping(true);
    try {
      await api.post(`/api/runs/${run!.id}/stop`);
      toast('Stopping run…');
      setRun((r) => (r ? { ...r, status: 'stopped' } : r)); // optimistic; polling confirms
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setStopping(false);
    }
  };

  const generateReport = async () => {
    try {
      setReport(await api.post<object>(`/api/runs/${run.id}/report`));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const downloadReport = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `report-${run.suiteName.replace(/\W+/g, '-')}-${run.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      <div className="row mb wrap">
        <h1 className="grow" style={{ margin: 0 }}>
          Run — <Link to={`/suites/${run.suiteId}`}>{run.suiteName}</Link>{' '}
          <span className={`chip status-${run.status}`}>{run.status}</span>
        </h1>
        {run.status === 'running' && (
          <>
            <button className="btn danger" disabled={stopping} onClick={() => void stop()}>
              {stopping ? 'Stopping…' : '⏹ Stop run'}
            </button>
            <Info k="runs.stop" />
          </>
        )}
        <button className="btn primary" disabled={run.status === 'running'} onClick={() => void generateReport()}>
          Generate report (stub)
        </button>
        <Info k="runs.report" />
      </div>

      <div className="card row wrap mb">
        <span>Cycles: <b>{run.cycles}</b></span>
        <span>Stop on failure: <b>{run.stopOnFailure ? 'yes' : 'no'}</b></span>
        <span>Started: <b>{new Date(run.startedAt).toLocaleString()}</b></span>
        {run.summary && (
          <>
            <span>Steps: <b>{run.summary.passedSteps}/{run.summary.totalSteps} passed</b></span>
            <span>Assertions: <b>{run.summary.passedAssertions}/{run.summary.totalAssertions} passed</b></span>
            <span>Duration: <b>{run.summary.durationMs} ms</b></span>
          </>
        )}
        {run.status === 'running' && <span className="muted">live — refreshing every second…</span>}
      </div>

      {run.cycleResults.map((c) => (
        <div key={c.cycle} className="mb">
          <h2>
            Cycle {c.cycle} <span className={`chip status-${c.passed ? 'passed' : 'failed'}`}>{c.passed ? 'passed' : 'failed'}</span>
            <Info k="runs.cycles" />
          </h2>
          {c.steps.map((s, i) => <StepRow key={`${s.stepId}-${i}`} s={s} />)}
        </div>
      ))}

      {report && (
        <Modal title="Report (stub — JSON format)" onClose={() => setReport(null)}>
          <p className="muted">
            This is the report-generation stub: a structured JSON document derived from the run.
            HTML/PDF rendering plugs in here later.
          </p>
          <div className="row mb"><button className="btn" onClick={downloadReport}>⬇ Download JSON</button></div>
          <pre className="body-view" style={{ maxHeight: '50vh' }}>{JSON.stringify(report, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}

function StepRow({ s }: { s: StepResult }) {
  return (
    <details className="step-res">
      <summary>
        <span className={`chip status-${s.status}`}>{s.status}</span>
        {s.request && <span className={`chip ${s.request.method}`}>{s.request.method}</span>}
        <b>{s.name}</b>
        {s.response && <span className="muted">HTTP {s.response.status} · {s.response.timeMs} ms</span>}
        {s.captured.length > 0 && (
          <span className="muted">captured: {s.captured.map((c) => `{{${c.key}}}`).join(' ')}</span>
        )}
      </summary>
      <div className="detail-body">
        {s.error && <div className="error-text mb">{s.error}</div>}
        {s.request && <div className="mono muted mb">{s.request.method} {s.request.url}</div>}

        {s.assertions.length > 0 && (
          <div className="mb">
            <h3>Assertions</h3>
            {s.assertions.map((a, i) => (
              <div className="assertion" key={i}>
                <span className={a.passed ? 'ok' : 'bad'}>{a.passed ? '✓' : '✗'}</span>
                <span>{a.name}</span>
                {a.message && <span className="muted">— {a.message}</span>}
              </div>
            ))}
          </div>
        )}

        {s.captured.length > 0 && (
          <div className="mb">
            <h3>Captured variables</h3>
            {s.captured.map((c, i) => (
              <div className="assertion" key={i}>
                <span className="mono">{'{{' + c.key + '}}'}</span>
                <span className="muted">= {c.value.length > 120 ? c.value.slice(0, 120) + '…' : c.value} ({c.scope})</span>
              </div>
            ))}
          </div>
        )}

        {s.logs.length > 0 && (
          <div className="mb">
            <h3>Script logs</h3>
            <pre className="body-view">{s.logs.join('\n')}</pre>
          </div>
        )}

        {s.response && (
          <div>
            <h3>Response body {s.response.bodyTruncated && <span className="muted">(truncated)</span>}</h3>
            <pre className="body-view">{tryPretty(s.response.body)}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function tryPretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
