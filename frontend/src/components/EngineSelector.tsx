import { useEffect, useState } from 'react';
import { getBackend, setBackend, pingBackend, type Backend } from '../api';
import BackendIcon from './BackendIcon';

interface Engine {
  id: Backend;
  name: string;
  blurb: string;
}
const ENGINES: Engine[] = [
  { id: 'node', name: 'Node', blurb: 'Express + TypeScript · node:vm sandbox' },
  { id: 'go', name: 'Go', blurb: 'chi + goja · single static binary' },
];

/**
 * Interactive backend selector for the Settings page. Both engines share the
 * database and session, so switching keeps you signed in with identical data —
 * it swaps the engine only. Gated: non-admins see the current selection as
 * read-only (the server also enforces this).
 */
export default function EngineSelector({ canSwitch }: { canSwitch: boolean }) {
  const [current, setCurrent] = useState<Backend>(getBackend());
  const [health, setHealth] = useState<Record<Backend, boolean>>({ node: false, go: false });

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const [node, go] = await Promise.all([pingBackend('node'), pingBackend('go')]);
      if (alive) setHealth({ node, go });
    };
    check();
    const id = setInterval(check, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const choose = (b: Backend) => {
    if (!canSwitch || b === current) return;
    setBackend(b);
    setCurrent(b);
    window.location.reload(); // refetch everything from the newly selected backend
  };

  return (
    <div className="card" style={{ width: 360 }}>
      <h2>Backend engine</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        Two interchangeable backends serve the same API over the same data and session.
        {canSwitch ? ' Pick which one handles your requests.' : ' Only admins can switch the engine.'}
      </p>
      <div className="engine-options">
        {ENGINES.map((e) => {
          const active = current === e.id;
          return (
            <button
              key={e.id}
              type="button"
              className={`engine-card${active ? ' active' : ''}`}
              disabled={!canSwitch && !active}
              aria-pressed={active}
              onClick={() => choose(e.id)}
            >
              <BackendIcon engine={e.id} size={34} animated={active} />
              <span className="engine-card-body">
                <span className="engine-card-name">
                  {e.name}
                  <span className={`bs-dot${health[e.id] ? ' up' : ''}`} />
                </span>
                <span className="engine-card-blurb">{e.blurb}</span>
              </span>
              {active && <span className="engine-card-badge">Active</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
