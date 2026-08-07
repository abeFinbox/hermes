import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Info } from '../legends';
import { useToast } from '../ui';
import { isHeraActive, type HeraRun, type HeraTrend } from '../types';
import { LatencyBars, TimeChart } from '../components/HeraCharts';

/**
 * One load test: summary, four stacked time-series charts, the per-step
 * breakdown, and the k6 output — the last of which is the only thing that
 * explains a run that died at second three.
 */

/** 2s, not RunDetail's 1s: the payload grows with the sample series, and a load
 *  test has no discrete events to wait on. */
const POLL_MS = 2000;

function num(v: number | undefined | null, digits = 0, suffix = ''): string {
  if (v === undefined || v === null || Number.isNaN(v)) return '—';
  return v.toFixed(digits) + suffix;
}

function Tile({ label, value, sub, breach }: { label: string; value: string; sub?: string; breach?: boolean }) {
  return (
    <div className={`hera-stat${breach ? ' breach' : ''}`}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

export default function HeraDetail() {
  const { id } = useParams();
  const [run, setRun] = useState<HeraRun | null>(null);
  const [stopping, setStopping] = useState(false);
  const toast = useToast();
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await api.get<HeraRun>(`/api/hera/${id}`);
        setRun(r);
        if (!isHeraActive(r.status) && timer.current) clearInterval(timer.current);
      } catch (e: any) {
        toast(e.message, 'error');
        if (timer.current) clearInterval(timer.current);
      }
    };
    // The FIRST load always runs. Only the repeat polls skip a hidden tab —
    // gating the initial fetch too leaves the page stuck on "Loading…" forever
    // whenever it is opened in the background.
    void load();
    timer.current = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [id]);

  const stop = async () => {
    if (!run) return;
    setStopping(true);
    try {
      await api.post(`/api/hera/${run.id}/stop`);
      toast('Stopping — draining in-flight virtual users…');
      // Optimistically 'stopping', never 'stopped': k6 drains first, and
      // claiming otherwise is a lie the next poll contradicts.
      setRun((r) => (r ? { ...r, status: 'stopping' } : r));
    } catch (e: any) {
      toast(e.message, 'error');
      // 409 means it already finished — resync now rather than show stale state
      if (e instanceof ApiError && e.status === 409) {
        api.get<HeraRun>(`/api/hera/${id}`).then(setRun).catch(() => {});
      }
    } finally {
      setStopping(false);
    }
  };

  const download = () => {
    if (!run) return;
    const blob = new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hera-${run.suiteName.replace(/[^\w.-]+/g, '-')}-${run.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!run) return <div className="muted">Loading…</div>;

  const s = run.summary;
  const lat: HeraTrend | null = s?.latency ?? null;
  const p95Threshold = run.config?.p95Ms ?? null;
  const p95Breached = !!(p95Threshold && lat && lat.p95 > p95Threshold);
  const active = isHeraActive(run.status);
  const clampNotes: string[] = run.requestedConfig?.clampNotes ?? [];
  const samples = run.samples ?? [];
  const ts = samples.map((x) => x.t);

  return (
    <div>
      <div className="row wrap mb">
        <h1 className="grow" style={{ margin: 0 }}>
          Load test — <Link to={`/suites/${run.suiteId}`}>{run.suiteName}</Link>{' '}
          <span className={`chip status-${run.status}`}>{run.status}</span>
        </h1>
        {active && (
          <>
            <button className="btn danger" disabled={stopping} onClick={() => void stop()}>⏹ Stop</button>
            <Info k="hera.stop" />
          </>
        )}
        <button className="btn" onClick={download}>⬇ Download JSON</button>
      </div>

      {clampNotes.length > 0 && (
        <div className="hera-notice">
          <b>Server limits applied.</b>
          <ul style={{ margin: '6px 0 0 18px' }}>{clampNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      )}

      {run.status === 'interrupted' && (
        <div className="hera-notice error">
          This run was interrupted — the process running it stopped before it finished, so its results are incomplete.
        </div>
      )}

      <div className="card row wrap mb">
        <span>VUs: <b>{run.config?.vus ?? '—'}</b></span>
        <span>Duration: <b>{run.config?.durationSec ?? '—'}s</b></span>
        <span>Rate cap: <b>{run.config?.rps ?? '—'}/s</b></span>
        <span>p95 threshold: <b>{p95Threshold ? `${p95Threshold} ms` : 'none'}</b></span>
        <span>Started: <b>{new Date(run.startedAt).toLocaleString()}</b></span>
        <span>Engine: <b>{run.backend}</b>{run.k6Version ? ` · k6 ${run.k6Version}` : ''}</span>
        <span className="grow" />
        {active && <span className="muted">live — refreshing every 2s…</span>}
      </div>

      {run.targetHosts?.length > 0 && (
        <div className="card mb">
          <b>Targets</b><Info k="hera.targets" />
          <div className="hera-targets mt">{run.targetHosts.join('  ·  ')}</div>
        </div>
      )}

      <div className="hera-stats">
        <Tile label="Requests" value={num(s?.requests)} />
        <Tile label="Error rate" value={s ? num(s.errorRate * 100, 2, '%') : '—'} />
        <Tile label="Requests/s" value={num(s?.rps, 1)} />
        <Tile label="p95" value={lat ? num(lat.p95, 1, ' ms') : '—'} sub={p95Threshold ? `threshold ${p95Threshold} ms` : undefined} breach={p95Breached} />
        <Tile label="p99" value={lat ? num(lat.p99, 1, ' ms') : '—'} />
        <Tile label="Iterations" value={num(s?.iterations)} />
        <Tile label="Checks" value={s ? `${Math.round(s.checksPassed)}/${Math.round(s.checksTotal)}` : '—'} breach={!!s && s.checksTotal > s.checksPassed} />
        <Tile label="Script errors" value={num(s?.scriptErrors)} breach={!!s && s.scriptErrors > 0} />
      </div>

      {!!s && s.suppressedGlobalWrites > 0 && (
        <div className="hera-notice">
          {Math.round(s.suppressedGlobalWrites)} global-scope variable write(s) were kept iteration-local — under load
          they cannot be written back to the shared store. Chaining within each iteration still worked.
        </div>
      )}

      {/* Stacked and x-aligned, deliberately NOT a 2x2 grid: reading a latency
          spike against the VU ramp at the same instant is the whole point. */}
      {samples.length >= 2 ? (
        <>
          <TimeChart
            title="Latency percentiles"
            note="Cumulative over the run so far — k6 reports a running trend that cannot be de-cumulated, so a late spike is diluted rather than sharp. p99 appears only in the final summary."
            t={ts}
            series={[
              { key: 'p50', label: 'p50', values: samples.map((x) => x.p50), tone: 'info' },
              { key: 'p90', label: 'p90', values: samples.map((x) => x.p90), tone: 'primary', dash: '6 3' },
              { key: 'p95', label: 'p95', values: samples.map((x) => x.p95), tone: 'warning', dash: '2 3' },
            ]}
            format={(v) => `${v.toFixed(1)} ms`}
            threshold={p95Threshold ? { value: p95Threshold, label: `threshold ${p95Threshold} ms` } : undefined}
            ariaSummary={`Response time percentiles over ${ts[ts.length - 1]} seconds. Final p95 ${samples[samples.length - 1].p95.toFixed(1)} milliseconds.`}
          />
          <TimeChart
            title="Throughput"
            note="Instantaneous — measured from the change between samples, not a running average."
            t={ts}
            series={[{ key: 'rps', label: 'requests/s', values: samples.map((x) => x.rps), tone: 'primary', area: true }]}
            format={(v) => v.toFixed(1)}
            ariaSummary={`Requests per second over ${ts[ts.length - 1]} seconds, peaking at ${Math.max(...samples.map((x) => x.rps)).toFixed(1)}.`}
          />
          <TimeChart
            title="Virtual users"
            note="If this sits below what you asked for, k6 could not keep up and the numbers understate the load."
            t={ts}
            series={[{ key: 'vus', label: 'VUs', values: samples.map((x) => x.vus), tone: 'primary', step: true, area: true }]}
            format={(v) => String(Math.round(v))}
            ariaSummary={`Active virtual users over ${ts[ts.length - 1]} seconds, peaking at ${Math.max(...samples.map((x) => x.vus))}.`}
          />
          <TimeChart
            title="Error rate"
            t={ts}
            series={[{ key: 'err', label: 'errors', values: samples.map((x) => x.errorRatePct), tone: 'danger', area: true }]}
            format={(v) => `${v.toFixed(2)}%`}
            // a floor of 5% so 0.2% is not drawn as full-height panic
            yMax={Math.max(5, ...samples.map((x) => x.errorRatePct))}
            ariaSummary={`Error rate over ${ts[ts.length - 1]} seconds, peaking at ${Math.max(...samples.map((x) => x.errorRatePct)).toFixed(2)} percent.`}
            showXAxis
          />
        </>
      ) : (
        <div className="card muted mb">
          {active ? 'Waiting for the first samples — k6 is starting up.' : 'No progress samples were recorded for this run.'}
        </div>
      )}

      {lat && <LatencyBars latency={lat} breachAt={p95Threshold} />}

      <h2>Per step<Info k="hera.stepTable" /></h2>
      {run.steps?.length ? (
        <table className="list">
          <thead>
            <tr>
              <th>Step</th><th className="num">Requests</th><th className="num">Err %</th>
              <th className="num">p50</th><th className="num">p95</th><th className="num">Max</th>
              <th className="num">Polls</th><th className="num">Wait p95</th>
            </tr>
          </thead>
          <tbody>
            {run.steps.map((st) => {
              const breach = !!(p95Threshold && st.latency && st.latency.p95 > p95Threshold);
              return (
                <tr key={st.stepId} className={breach ? 'hera-row-breach' : undefined}>
                  <td><span className={`chip ${st.method}`}>{st.method}</span> <b>{st.name}</b></td>
                  <td className="num">{num(st.requests)}</td>
                  <td className="num">{num(st.errorRate * 100, 2)}</td>
                  <td className="num">{st.latency ? num(st.latency.p50, 1) : '—'}</td>
                  <td className="num">
                    {st.latency
                      ? (breach ? <span className="chip status-breached">⚠ {num(st.latency.p95, 1)}</span> : num(st.latency.p95, 1))
                      : '—'}
                  </td>
                  <td className="num">{st.latency ? num(st.latency.max, 1) : '—'}</td>
                  <td className="num">{st.pollAttempts ? num(st.pollAttempts.p95, 1) : '—'}</td>
                  <td className="num">{st.pollWaitMs ? num(st.pollWaitMs.p95, 0, ' ms') : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="card muted">No per-step results{active ? ' yet — they arrive when the run finishes.' : '.'}</div>
      )}

      {run.steps?.some((st) => st.pollWaitMs) && (
        <div className="muted mt" style={{ fontSize: 12 }}>
          <b>Wait p95</b> is time-to-completion for a polled step — how long a caller waited for the async work to
          finish under this load.<Info k="hera.poll" />
        </div>
      )}

      {run.stderrTail && (
        <details className="step-res mt">
          <summary>k6 output</summary>
          <div className="detail-body"><pre className="body-view">{run.stderrTail}</pre></div>
        </details>
      )}
    </div>
  );
}
