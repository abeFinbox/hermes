import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Info } from '../legends';
import { formatBytes } from '../pages/Files';

interface Sample {
  t: number;
  cpu: number; // 0–100
  rss: number; // bytes
  heapUsed: number; // bytes
}
interface Metrics {
  samples: Sample[];
  totalMem: number;
  sampleMs: number;
}

const POLL_MS = 2000;
const W = 90;
const H = 26;

// Tiny single-series sparkline. Identity comes from the text label next to it,
// exact values from the tooltip — color is never the only carrier.
function Sparkline({ values, max, title }: { values: number[]; max: number; title: string }) {
  if (values.length < 2) return <svg className="spark" width={W} height={H} aria-hidden="true" />;
  const safeMax = max > 0 ? max : 1;
  const step = W / (values.length - 1);
  const y = (v: number) => H - 2 - (Math.min(v, safeMax) / safeMax) * (H - 4);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `0,${H} ${pts} ${W},${H}`;
  return (
    <svg className="spark" width={W} height={H} role="img" aria-label={title}>
      <title>{title}</title>
      <polygon points={area} className="spark-fill" />
      <polyline points={pts} className="spark-line" fill="none" />
    </svg>
  );
}

export default function TopbarMetrics() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [offline, setOffline] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const m = await api.get<Metrics>('/api/metrics');
        if (cancelled) return;
        setMetrics(m);
        setOffline(false);
      } catch {
        if (!cancelled) setOffline(true); // backend restarting — dim quietly, no toasts
      }
    };
    void poll();
    timer.current = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer.current);
    };
  }, []);

  if (!metrics) return null;

  const s = metrics.samples;
  const latest = s[s.length - 1];
  const cpuSeries = s.map((x) => x.cpu);
  const rssSeries = s.map((x) => x.rss);
  const rssMax = Math.max(...rssSeries);
  const windowSec = Math.round((s.length * metrics.sampleMs) / 1000);
  const cpuTitle = `Backend CPU: ${latest.cpu.toFixed(1)}% of one core — last ${windowSec}s`;
  const memTitle = `Backend memory: ${formatBytes(latest.rss)} RSS (heap ${formatBytes(latest.heapUsed)}) of ${formatBytes(metrics.totalMem)} total — last ${windowSec}s`;

  return (
    <div className={`topbar-metrics${offline ? ' offline' : ''}`} title={offline ? 'Backend unreachable — showing last known values' : undefined}>
      <div className="metric" title={cpuTitle}>
        <span className="metric-label">CPU <b>{latest.cpu.toFixed(1)}%</b></span>
        <Sparkline values={cpuSeries} max={100} title={cpuTitle} />
      </div>
      <div className="metric" title={memTitle}>
        <span className="metric-label">MEM <b>{formatBytes(latest.rss)}</b></span>
        <Sparkline values={rssSeries} max={rssMax} title={memTitle} />
      </div>
      <Info k="topbar.metrics" />
    </div>
  );
}
