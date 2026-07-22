import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useToast } from '../ui';
import type { Run } from '../types';

export default function Runs() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [params] = useSearchParams();
  const suiteId = params.get('suiteId');
  const toast = useToast();

  useEffect(() => {
    const load = () =>
      api.get<Run[]>(`/api/runs${suiteId ? `?suiteId=${suiteId}` : ''}`).then(setRuns).catch((e) => toast(e.message, 'error'));
    void load();
    const t = setInterval(load, 3000); // keep "running" rows fresh
    return () => clearInterval(t);
  }, [suiteId]);

  return (
    <div>
      <h1>Run history {suiteId && <span className="muted">(filtered by suite)</span>}</h1>
      {runs.length === 0 ? (
        <div className="card muted">No runs yet. Open a suite and click ▶ Run.</div>
      ) : (
        <table className="list">
          <thead><tr><th>Suite</th><th>Status</th><th>Cycles</th><th>Result</th><th>Started</th><th>Duration</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/runs/${r.id}`}><b>{r.suiteName}</b></Link></td>
                <td><span className={`chip status-${r.status}`}>{r.status}</span></td>
                <td>{r.cycles}</td>
                <td className="muted">
                  {r.summary ? `${r.summary.passedSteps}/${r.summary.totalSteps} steps, ${r.summary.passedAssertions}/${r.summary.totalAssertions} assertions` : '—'}
                </td>
                <td className="muted">{new Date(r.startedAt).toLocaleString()}</td>
                <td className="muted">{r.summary ? `${r.summary.durationMs} ms` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
