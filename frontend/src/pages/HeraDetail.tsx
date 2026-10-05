import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Info } from '../legends';
import { Modal, useToast } from '../ui';
import { useAuth } from '../App';
import { permsFor } from '../perms';
import CurlBlock from '../components/CurlBlock';
import {
  isHeraActive,
  type HeraLogLine,
  type HeraLogsResponse,
  type HeraRun,
  type HeraStepCurl,
  type HeraTrend,
} from '../types';
import { LatencyBars, TimeChart } from '../components/HeraCharts';
import HeraGlyph from '../components/HeraGlyph';
import LogViewer from '../components/LogViewer';

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
  const [logs, setLogs] = useState<HeraLogLine[]>([]);
  const [logState, setLogState] = useState<{ dropped: number; notice?: string }>({ dropped: 0 });
  const [curl, setCurl] = useState<{ stepId: string; loading: boolean; data?: HeraStepCurl } | null>(null);
  const { user } = useAuth();
  const perms = permsFor(user?.role, user?.isAdmin);
  const toast = useToast();
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const logTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  /** Log cursor and the sample bookkeeping for incremental fetches. */
  const cursor = useRef(0);
  const held = useRef<{ lastT: number; count: number }>({ lastT: -1, count: 0 });

  useEffect(() => {
    const load = async () => {
      try {
        // Incremental: ask only for samples newer than the last one held. The
        // integrity check below is what makes that safe.
        const since = held.current.lastT >= 0 ? `?since=${held.current.lastT}` : '';
        const r = await api.get<HeraRun>(`/api/hera/${id}${since}`);
        setRun((prev) => {
          const incoming = r.samples ?? [];
          if (!prev || !since) {
            held.current = { lastT: incoming.length ? incoming[incoming.length - 1].t : -1, count: incoming.length };
            return r;
          }
          // The server decimates its sample blob past 256KB and rewrites `t` when
          // the live buffer fills, so points we hold may no longer exist there.
          // sampleCount is the arbiter: if ours plus theirs does not add up, our
          // copy is stale — drop it and refetch whole on the next tick.
          const merged = [...(prev.samples ?? []), ...incoming];
          if (r.sampleCount !== held.current.count + incoming.length) {
            held.current = { lastT: -1, count: 0 };
            return { ...r, samples: prev.samples ?? [] };
          }
          held.current = {
            lastT: merged.length ? merged[merged.length - 1].t : -1,
            count: merged.length,
          };
          return { ...r, samples: merged };
        });
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

  /**
   * Log poll, deliberately separate from the run poll: it targets a different
   * engine (whichever owns the run) and it stops on a different condition (the
   * first 'tail' response, which is the complete persisted record).
   */
  useEffect(() => {
    if (!run) return;
    const owner = run.backend === 'go' ? 'go' : 'node';
    const stop = () => {
      if (logTimer.current) clearInterval(logTimer.current);
      logTimer.current = undefined;
    };
    const load = async () => {
      try {
        const r = await api.getOn<HeraLogsResponse>(owner, `/api/hera/${id}/logs?sinceLine=${cursor.current}`);
        if (r.source === 'tail') {
          // Renumbered from 1 — replace, never append. Then stop: this is final.
          cursor.current = 0;
          setLogs(r.lines);
          setLogState({ dropped: 0, notice: undefined });
          stop();
          return;
        }
        if (r.source === 'none') {
          setLogState({ dropped: 0, notice: r.reason });
          return;
        }
        cursor.current = r.cursor;
        if (r.lines.length) setLogs((prev) => [...prev, ...r.lines]);
        setLogState({ dropped: r.dropped, notice: undefined });
      } catch {
        // A failed log poll must not toast: it fires every 2s, and the run
        // payload's own poll already reports a backend that has gone away.
        stop();
      }
    };
    void load();
    if (isHeraActive(run.status)) {
      logTimer.current = setInterval(() => {
        if (!document.hidden) void load();
      }, POLL_MS);
    }
    return stop;
    // run.backend and run.status are what matter; re-running on every poll would
    // restart the interval endlessly.
  }, [id, run?.backend, run?.status]);

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

  /**
   * Fetch on demand rather than with the run: this command carries real
   * credentials, so it is neither persisted nor sent to anyone who cannot launch
   * a run. Always from the owning engine, so the answer matches what ran.
   */
  const showCurl = async (stepId: string) => {
    if (!run) return;
    setCurl({ stepId, loading: true });
    try {
      const owner = run.backend === 'go' ? 'go' : 'node';
      const r = await api.getOn<HeraStepCurl>(owner, `/api/hera/${run.id}/curl?stepId=${encodeURIComponent(stepId)}`);
      setCurl({ stepId, loading: false, data: r });
    } catch (e: any) {
      setCurl(null);
      toast(e.message, 'error');
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
        <h1 className="grow hera-title" style={{ margin: 0 }}>
          <HeraGlyph size={20} title="Hera" /> Load test — <Link to={`/suites/${run.suiteId}`}>{run.suiteName}</Link>{' '}
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
        {/* Absent on runs recorded before profiles existed, which were all flat. */}
        <span>Mode: <b>{run.config?.mode ?? 'constant'}</b><Info k="hera.mode" /></span>
        <span>{run.config?.mode === 'rate' ? 'Max VUs' : 'VUs'}: <b>{run.config?.vus ?? '—'}</b></span>
        <span>Duration: <b>{run.config?.durationSec ?? '—'}s</b></span>
        <span>Rate cap: <b>{run.config?.rps ?? '—'}/s</b></span>
        <span>p95 threshold: <b>{p95Threshold ? `${p95Threshold} ms` : 'none'}</b></span>
        <span>Started: <b>{new Date(run.startedAt).toLocaleString()}</b></span>
        {/* Name as it was at launch — a renamed or deleted environment must not
            make an old run unreadable. */}
        <span>Environment: <b>{run.envName || 'none'}</b></span>
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
        {/* Only meaningful when something actually dropped — but then it is the
            most important number on the page: in rate mode it means the target
            could not absorb the arrival rate. */}
        {!!s && s.droppedIterations > 0 && (
          <Tile
            label="Dropped iterations"
            value={num(s.droppedIterations)}
            sub="arrival rate exceeded capacity"
            breach
          />
        )}
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
              {perms.canLoadTest && <th />}
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
                  {perms.canLoadTest && (
                    <td className="num">
                      <button
                        className="btn small"
                        onClick={() => void showCurl(st.stepId)}
                        title="Reproduce this step's request in a terminal"
                      >
                        ⧉ cURL
                      </button>
                    </td>
                  )}
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

      {/* Always rendered, and open while the run is live. The old truthiness gate
          on stderrTail meant the panel did not exist during a run (the column is
          only written at exit) and stayed absent for a run that passed quietly. */}
      <details className="step-res mt" open={active}>
        <summary>k6 output{logs.length > 0 ? ` (${logs.length.toLocaleString()} lines)` : ''}</summary>
        <div className="detail-body">
          {logs.length > 0 ? (
            <LogViewer lines={logs} live={active} dropped={logState.dropped} notice={logState.notice} />
          ) : (
            <div className="muted">
              {logState.notice
                ? logState.notice
                : active
                  ? 'No output yet — k6 is starting up.'
                  : 'k6 produced no output.'}
            </div>
          )}
        </div>
      </details>

      {curl && (
        <Modal title={`cURL — ${curl.data?.name ?? 'step'}`} onClose={() => setCurl(null)}>
          {curl.loading ? (
            <div className="muted">Building…</div>
          ) : curl.data ? (
            <>
              {curl.data.staleWarning && (
                <div className="hera-notice mb">
                  The suite has been edited since this run, so this command reflects the request <b>as it is now</b>,
                  not as it ran.
                </div>
              )}
              {curl.data.unresolved.length > 0 && (
                <div className="hera-notice info mb">
                  Left as placeholders because they are captured during the run, not before it:{' '}
                  <span className="mono">{curl.data.unresolved.map((u) => `{{${u}}}`).join(' ')}</span>. Substitute a
                  real value before running.
                </div>
              )}
              <CurlBlock curl={curl.data.curl} />
            </>
          ) : null}
        </Modal>
      )}
    </div>
  );
}
