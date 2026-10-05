/**
 * The Hera sigil — a six-pointed asterisk on a staff, crossed near the foot.
 * Drawn from the project mark. Strokes use currentColor, so it takes the colour
 * of whatever it sits in (ink on the parchment tear, --primary in a header).
 */
export default function HeraGlyph({ size = 24, title }: { size?: number; title?: string }) {
  return (
    <svg
      className="hera-glyph"
      width={size}
      height={size * 1.4}
      viewBox="0 0 100 140"
      fill="none"
      stroke="currentColor"
      strokeWidth={9}
      strokeLinecap="round"
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {/* staff: the full vertical stem */}
      <line x1="50" y1="20" x2="50" y2="122" />
      {/* two diagonals through the asterisk centre (50,46); with the stem they
          make an even six-pointed star */}
      <line x1="30" y1="35" x2="70" y2="57" />
      <line x1="70" y1="35" x2="30" y2="57" />
      {/* crossbar near the foot */}
      <line x1="33" y1="104" x2="67" y2="104" />
    </svg>
  );
}
