import type { PollAttempt } from '../types';
import BodyViewer from './BodyViewer';

/**
 * Poll history for a step that used polling — one collapsible row per attempt,
 * showing the status/time and the response body of that attempt. The attempt
 * where stop() fired is flagged. Shared by the Run detail and the editor's
 * single-step Send result.
 */
export default function PollAttempts({ attempts }: { attempts: PollAttempt[] }) {
  if (!attempts || attempts.length === 0) return null;
  return (
    <div className="mb">
      <h3>Polling — {attempts.length} attempt{attempts.length === 1 ? '' : 's'}</h3>
      {attempts.map((a) => (
        <details className="step-res poll-attempt" key={a.attempt} open={a.stopped}>
          <summary>
            <span className="muted mono">#{a.attempt}</span>
            <span className={`chip status-${a.status >= 200 && a.status < 400 ? 'passed' : 'failed'}`}>HTTP {a.status}</span>
            <span className="muted">{a.timeMs} ms</span>
            {a.stopped && <span className="chip status-passed">stop() ✓</span>}
          </summary>
          <div className="detail-body">
            <BodyViewer body={a.body} truncated={a.bodyTruncated} />
          </div>
        </details>
      ))}
    </div>
  );
}
