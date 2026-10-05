import { useNavigate } from 'react-router-dom';
import HeraGlyph from './HeraGlyph';

/**
 * A torn strip at the foot of the home page. The Hermes "paper" rips along a
 * ragged edge and Hera shows through underneath — click anywhere to open it.
 *
 * This is Hera's front door instead of a plain sidebar link: the goddess who
 * sends the trials sits beneath everything, revealed only when you tear the page.
 */
export default function HeraTear() {
  const navigate = useNavigate();
  return (
    <div
      className="hera-tear"
      role="link"
      tabIndex={0}
      aria-label="Load testing with Hera"
      onClick={() => navigate('/hera')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate('/hera');
        }
      }}
    >
      {/* the ragged rip: filled with the PAGE colour so it eats into the panel */}
      <svg className="hera-tear-rip" viewBox="0 0 1200 26" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0,0 L0,14 L34,7 L72,17 L110,5 L150,15 L196,6 L240,16 L286,8 L330,18 L378,6 L420,15 L470,7 L512,17 L556,6 L600,15 L648,7 L690,17 L738,6 L780,16 L826,7 L868,17 L912,6 L956,15 L1000,7 L1044,17 L1088,6 L1130,16 L1168,7 L1200,14 L1200,0 Z" />
      </svg>

      <div className="hera-tear-body">
        <div className="hera-tear-mark">
          <HeraGlyph size={30} title="Hera" />
        </div>
        <div className="hera-tear-copy">
          <div className="hera-tear-name">HERA</div>
          <div className="hera-tear-sub">Load testing lives beneath. Tear the page — or hit ⚡ Load test on any suite.</div>
        </div>
        <div className="hera-tear-cta" aria-hidden="true">open ↝</div>
      </div>
    </div>
  );
}
