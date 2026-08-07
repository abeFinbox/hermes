import { useMemo, useState } from 'react';

/**
 * Hand-rolled SVG time-series charts.
 *
 * This app ships no chart library, and the only prior art is the 90x26
 * Sparkline in TopbarMetrics.tsx. The technique that makes a full-width
 * responsive chart possible without one:
 *
 *   viewBox="0 0 1000 100" + preserveAspectRatio="none"
 *     x stretches to the container, y is pinned to the CSS height. No
 *     measurement, no ResizeObserver, responsive for free.
 *   vector-effect="non-scaling-stroke" on every stroked element
 *     without it, that non-uniform scaling smears a 2px line into a ribbon.
 *
 * Two consequences fall out of that, and both are load-bearing:
 *   - ALL TEXT LIVES OUTSIDE THE SVG. Stretched <text> would be unreadable, so
 *     axes, legends and readouts are HTML.
 *   - no circular markers, for the same reason. The hover indicator is a
 *     vertical line, which is immune to distortion.
 *
 * Colour comes from CSS classes only — never a JS-computed value. applyTheme()
 * in themes.tsx is the sole writer of the CSS variables, and reading computed
 * styles here would break the Appearance page's live preview.
 */

export type Tone = 'primary' | 'info' | 'success' | 'warning' | 'danger' | 'muted';

export interface Series {
  key: string;
  label: string;
  values: number[];
  tone: Tone;
  /** Second identity carrier, so the chart survives greyscale and colour blindness. */
  dash?: string;
  /** Step interpolation — right for VU counts, wrong for latency. */
  step?: boolean;
  /** Only honoured for a single-series chart: overlapping fills mud together. */
  area?: boolean;
}

const VIEW_W = 1000;
const VIEW_H = 100;
const PAD = 2;
/** ~4 viewBox units apart at 1000 wide — below visual resolution. */
export const MAX_POINTS = 240;

/**
 * Bucket down to at most `max` points.
 *
 * Takes the bucket MAX rather than a mean: smoothing away a spike would hide
 * exactly what a load test is looking for.
 */
export function decimate(values: number[], max = MAX_POINTS): number[] {
  if (values.length <= max) return values;
  const size = Math.ceil(values.length / max);
  const out: number[] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(Math.max(...values.slice(i, i + size)));
  }
  return out;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

const xAt = (i: number, n: number) => (n <= 1 ? 0 : (i / (n - 1)) * VIEW_W);
const yAt = (v: number, max: number) => VIEW_H - PAD - (Math.min(Math.max(v, 0), max) / max) * (VIEW_H - PAD * 2);

function linePath(values: number[], max: number, step: boolean): string {
  if (!values.length) return '';
  const n = values.length;
  let d = '';
  values.forEach((v, i) => {
    const x = xAt(i, n);
    const y = yAt(v, max);
    if (i === 0) d += `M ${x.toFixed(2)} ${y.toFixed(2)}`;
    else if (step) d += ` L ${x.toFixed(2)} ${yAt(values[i - 1], max).toFixed(2)} L ${x.toFixed(2)} ${y.toFixed(2)}`;
    else d += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  return d;
}

export interface TimeChartProps {
  /** Seconds since run start, same length as every series. */
  t: number[];
  series: Series[];
  format: (v: number) => string;
  yMax?: number;
  /** CSS pixel height. The viewBox is always 100 tall. */
  height?: number;
  threshold?: { value: number; label: string };
  ariaSummary: string;
  /** Rendered under the title — used to flag the cumulative latency caveat. */
  note?: string;
  title: string;
  /** Only the bottom chart in a stack draws the x tick row. */
  showXAxis?: boolean;
}

export function TimeChart({
  t, series, format, yMax, height = 150, threshold, ariaSummary, note, title, showXAxis,
}: TimeChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  const data = useMemo(() => {
    const ts = decimate(t);
    const ss = series.map((s) => ({ ...s, values: decimate(s.values) }));
    const observed = Math.max(1, ...ss.flatMap((s) => s.values), threshold?.value ?? 0);
    return { ts, ss, max: yMax ?? niceMax(observed) };
  }, [t, series, yMax, threshold?.value]);

  const n = data.ts.length;
  const single = data.ss.length === 1;

  if (n < 2) {
    return (
      <div className="card mb">
        <b>{title}</b>
        {note && <div className="muted" style={{ fontSize: 11 }}>{note}</div>}
        <div className="hera-chart-empty" style={{ height }}>Waiting for the first samples…</div>
      </div>
    );
  }

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1)))));
  };

  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? 0) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? 0) - 1));
    else if (e.key === 'Home') setHover(0);
    else if (e.key === 'End') setHover(n - 1);
    else return;
    e.preventDefault();
  };

  const idx = hover ?? n - 1;

  return (
    <div className="card mb">
      <b>{title}</b>
      {note && <div className="muted" style={{ fontSize: 11 }}>{note}</div>}

      <div className="hera-chart mt" style={{ height }}>
        <div className="hera-axis-y">
          <span>{format(data.max)}</span>
          <span>{format(data.max / 2)}</span>
          <span>0</span>
        </div>
        <svg
          className="chart" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none"
          style={{ height }} role="img" aria-label={ariaSummary} tabIndex={0}
          onKeyDown={onKey} onMouseLeave={() => setHover(null)}
        >
          <title>{ariaSummary}</title>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} className="chart-grid" vectorEffect="non-scaling-stroke"
              x1={0} x2={VIEW_W} y1={VIEW_H * f} y2={VIEW_H * f} />
          ))}

          {single && data.ss[0].area && (
            <polygon className={`chart-area tone-${data.ss[0].tone}`}
              points={
                `0,${VIEW_H} ` +
                data.ss[0].values.map((v, i) => `${xAt(i, n).toFixed(2)},${yAt(v, data.max).toFixed(2)}`).join(' ') +
                ` ${VIEW_W},${VIEW_H}`
              } />
          )}

          {data.ss.map((s) => (
            <path key={s.key} className={`chart-line tone-${s.tone}`} vectorEffect="non-scaling-stroke"
              strokeDasharray={s.dash} d={linePath(s.values, data.max, !!s.step)} />
          ))}

          {threshold && threshold.value <= data.max && (
            <line className="chart-threshold" vectorEffect="non-scaling-stroke"
              x1={0} x2={VIEW_W} y1={yAt(threshold.value, data.max)} y2={yAt(threshold.value, data.max)} />
          )}

          {hover !== null && (
            <line className="chart-cursor" vectorEffect="non-scaling-stroke"
              x1={xAt(hover, n)} x2={xAt(hover, n)} y1={0} y2={VIEW_H} />
          )}

          <rect className="chart-hit" x={0} y={0} width={VIEW_W} height={VIEW_H} onMouseMove={onMove} />
        </svg>
      </div>

      {showXAxis && (
        <div className="hera-axis-x">
          <span>{data.ts[0]}s</span>
          <span>{data.ts[Math.floor(n / 2)]}s</span>
          <span>{data.ts[n - 1]}s</span>
        </div>
      )}

      <div className="hera-readout">
        <span className="muted">t = {data.ts[idx]}s{hover === null ? ' (latest)' : ''}</span>
        {data.ss.map((s) => (
          <span key={s.key}>
            <span className={`chart-swatch tone-${s.tone}${s.dash ? ' dashed' : ''}`} />
            {s.label}: <b>{format(s.values[idx])}</b>
          </span>
        ))}
        {threshold && <span className="muted">· {threshold.label}</span>}
      </div>

      {/* Third carrier: authoritative for screen readers, and the honest
          fallback if a custom theme makes two hues indistinguishable. */}
      <details className="step-res mt">
        <summary>Data table</summary>
        <div className="detail-body" style={{ maxHeight: 240, overflow: 'auto' }}>
          <table className="list">
            <thead>
              <tr><th className="num">t</th>{data.ss.map((s) => <th key={s.key} className="num">{s.label}</th>)}</tr>
            </thead>
            <tbody>
              {data.ts.map((tv, i) => (
                <tr key={i}>
                  <td className="num">{tv}s</td>
                  {data.ss.map((s) => <td key={s.key} className="num">{format(s.values[i])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Aggregate min/p50/p90/p95/p99/max as horizontal bars. Not a histogram: the
 *  contract carries precomputed percentiles, and inventing buckets from them
 *  would be fabricating data. */
export function LatencyBars({ latency, breachAt }: { latency: { min: number; p50: number; p90: number; p95: number; p99: number; max: number }; breachAt?: number | null }) {
  const rows: Array<[string, number]> = [
    ['min', latency.min], ['p50', latency.p50], ['p90', latency.p90],
    ['p95', latency.p95], ['p99', latency.p99], ['max', latency.max],
  ];
  const max = Math.max(1, latency.max, breachAt ?? 0);
  return (
    <div className="card mb">
      <b>Latency distribution</b>
      <table className="list mt">
        <tbody>
          {rows.map(([label, v]) => (
            <tr key={label}>
              <td style={{ width: 52 }}>{label}</td>
              <td>
                <div className="hera-bar">
                  <div className={breachAt && v > breachAt ? 'fill breach' : 'fill'} style={{ width: `${(v / max) * 100}%` }} />
                </div>
              </td>
              <td className="num" style={{ width: 90 }}>{v.toFixed(1)} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
