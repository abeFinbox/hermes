import type { Backend } from '../api';

/**
 * Brand-ish icons for the two backend engines: a Go gopher and the Node.js
 * hexagon. `animated` adds a subtle idle motion (gopher bounces, hex pulses)
 * used to highlight the active engine. Pure inline SVG — no external assets.
 */
export default function BackendIcon({
  engine,
  size = 18,
  animated = false,
}: {
  engine: Backend;
  size?: number;
  animated?: boolean;
}) {
  const cls = `eng-ico ${engine}${animated ? ' animated' : ''}`;
  if (engine === 'go') {
    return (
      <svg className={cls} width={size} height={size} viewBox="0 0 64 64" aria-label="Go" role="img">
        <circle cx="20" cy="13" r="6" fill="#00ACD7" />
        <circle cx="44" cy="13" r="6" fill="#00ACD7" />
        <ellipse cx="32" cy="35" rx="22" ry="24" fill="#00ACD7" />
        <circle cx="24" cy="27" r="9" fill="#fff" />
        <circle cx="40" cy="27" r="9" fill="#fff" />
        <circle cx="26" cy="28" r="4" fill="#111" />
        <circle cx="42" cy="28" r="4" fill="#111" />
        <circle cx="27.3" cy="26.7" r="1.3" fill="#fff" />
        <circle cx="43.3" cy="26.7" r="1.3" fill="#fff" />
        <ellipse cx="32" cy="37" rx="3.6" ry="2.6" fill="#5b3a1a" />
        <rect x="29" y="40" width="6" height="7" rx="1.6" fill="#fff" stroke="#d9b48f" strokeWidth="0.6" />
        <line x1="32" y1="40" x2="32" y2="47" stroke="#d9b48f" strokeWidth="0.6" />
      </svg>
    );
  }
  return (
    <svg className={cls} width={size} height={size} viewBox="0 0 64 64" aria-label="Node.js" role="img">
      <polygon points="32,3 56,17.5 56,46.5 32,61 8,46.5 8,17.5" fill="#539E43" />
      <polygon points="32,10 50,20.5 50,43.5 32,54 14,43.5 14,20.5" fill="#3C7A30" />
      <text x="32" y="40" fontSize="20" fontWeight="700" textAnchor="middle" fill="#fff" fontFamily="system-ui, sans-serif">n</text>
    </svg>
  );
}
