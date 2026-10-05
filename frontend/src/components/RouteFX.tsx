import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import HeraGlyph from './HeraGlyph';

/**
 * A whisper of a page transition: on every route change the Hera sigil drifts
 * into frame and fades out. Non-blocking (pointer-events: none), low opacity —
 * meant to be felt more than seen. Hera watches every move.
 */
export default function RouteFX() {
  const { pathname } = useLocation();
  const [on, setOn] = useState(false);

  useEffect(() => {
    setOn(true);
    const t = setTimeout(() => setOn(false), 520);
    return () => clearTimeout(t);
  }, [pathname]);

  return (
    <div className={`route-fx${on ? ' on' : ''}`} aria-hidden="true">
      <HeraGlyph size={140} />
    </div>
  );
}
