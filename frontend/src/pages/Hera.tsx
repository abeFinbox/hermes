import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Info } from '../legends';
import { useToast } from '../ui';
import { isHeraActive, type HeraCapability, type HeraRunListItem } from '../types';
import HeraLaunchForm from '../components/HeraLaunchForm';

/**
 * Hera — launch a load test, and the history of past ones.
 *
 * The capability banner is what tells you whether k6 is even present on the host
 * running the SELECTED backend: each engine probes its own host, so the answer
 * can differ between Node and Go.
 */
export default function Hera() {
  const [items, setItems] = useState<HeraRunListItem[]>([]);
  const [caps, setCaps] = useState<HeraCapability | null>(null);
  const toast = useToast();
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const [params] = useSearchParams(); // ?suiteId= arrives from the suite editor

  const load = () => api.get<HeraRunListItem[]>('/api/hera').then(setItems).catch((e) => toast(e.message, 'error'));

  useEffect(() => {
    void load();
    api.get<HeraCapability>('/api/hera/capabilities').then(setCaps).catch(() => setCaps(null));
    // Unlike Runs.tsx this clears itself once nothing is active — these rows are
    // heavier, and a finished history does not change.
    timer.current = setInterval(() => {
      void api
        .get<HeraRunListItem[]>('/api/hera')
        .then((rows) => {
          setItems(rows);
          if (!rows.some((r) => isHeraActive(r.status)) && timer.current) clearInterval(timer.current);
        })
        .catch(() => timer.current && clearInterval(timer.current));
    }, 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const recheck = async () => {
    setCaps(await api.get<HeraCapability>('/api/hera/capabilities?recheck=1'));
  };

  return (
    <div>
      <div className="row wrap mb">
        <h1 className="grow" style={{ margin: 0 }}>Hera — load testing</h1>
        {caps?.version && <span className="muted mono">k6 {caps.version}{caps.platform ? ` · ${caps.platform}` : ''}</span>}
        <Info k="nav.hera" />
      </div>

      {caps && !caps.available && (
        <div className="hera-notice error">
          <b>Load testing is unavailable on this backend.</b>
          <div className="mt">{caps.reason}</div>
          <button className="btn small mt" onClick={() => void recheck()}>↻ Recheck</button>
          <Info k="hera.unavailable" />
        </div>
      )}

      {caps?.available && !caps.canLaunch && (
        <div className="hera-notice">
          You can view load tests but not start them — starting is limited to admins on this instance.
        </div>
      )}

      {caps?.available && caps.selfMockOnly && (
        <div className="hera-notice info">
          No <span className="mono">HERA_TARGET_ALLOW</span> is configured, so Hera may only target this instance's own{' '}
          <span className="mono">/mock</span> API. Set it to load-test anything real.
          <Info k="hera.targets" />
        </div>
      )}

      {caps?.available && caps.canLaunch && (
        <HeraLaunchForm
          caps={caps}
          initialSuiteId={params.get('suiteId')}
          activeRun={items.find((r) => isHeraActive(r.status)) ?? null}
          onLaunched={() => void load()}
        />
      )}

      {items.length === 0 ? (
        <div className="card muted">No load tests yet.</div>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Suite</th><th>Status</th><th className="num">VUs</th><th className="num">Duration</th>
              <th className="num">Requests</th><th className="num">Err %</th><th className="num">p95</th><th>Started</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/hera/${r.id}`}><b>{r.suiteName}</b></Link></td>
                <td><span className={`chip status-${r.status}`}>{r.status}</span></td>
                <td className="num">{r.config?.vus ?? '—'}</td>
                <td className="num">{r.config?.durationSec != null ? `${r.config.durationSec}s` : '—'}</td>
                <td className="num">{r.summary ? Math.round(r.summary.requests) : '—'}</td>
                <td className="num">{r.summary ? (r.summary.errorRate * 100).toFixed(2) : '—'}</td>
                <td className="num">{r.summary?.latency ? `${r.summary.latency.p95.toFixed(1)} ms` : '—'}</td>
                <td className="muted">{new Date(r.startedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
