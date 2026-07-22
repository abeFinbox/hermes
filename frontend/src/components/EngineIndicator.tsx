import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBackend, pingBackend, type Backend } from '../api';
import BackendIcon from './BackendIcon';

/**
 * Read-only "which engine is serving you" notification for the topbar, shown
 * next to the metrics. It reflects the active backend (icon + name + live
 * health dot) but does not switch it — switching lives on the Settings page
 * (admin only). Clicking jumps there.
 */
export default function EngineIndicator() {
  const navigate = useNavigate();
  const active: Backend = getBackend();
  const [up, setUp] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const ok = await pingBackend(active);
      if (alive) setUp(ok);
    };
    check();
    const id = setInterval(check, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active]);

  return (
    <button
      type="button"
      className={`engine-pill ${active}`}
      onClick={() => navigate('/settings')}
      title={`Serving via the ${active === 'go' ? 'Go' : 'Node'} backend — ${up ? 'online' : 'offline'}. Click to change (admin).`}
    >
      <BackendIcon engine={active} size={18} animated />
      <span className="engine-pill-label">
        <span className="engine-pill-kicker">Engine</span>
        <span className="engine-pill-name">{active === 'go' ? 'Go' : 'Node'}</span>
      </span>
      <span className={`bs-dot${up ? ' up' : ''}`} />
    </button>
  );
}
