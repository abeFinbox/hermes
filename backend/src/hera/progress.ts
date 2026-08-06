import net from 'node:net';

/**
 * Live progress, sampled from k6's own REST API on loopback.
 *
 * Why not `--out json`: it emits one line per metric per request — roughly 1.2M
 * lines for a 500rps/5min run — which would have to be streamed and parsed by
 * the API process serving the UI. The REST endpoint gives pre-aggregated numbers
 * for a single GET instead, with no disk and no volume problem.
 *
 * Security posture: bound to 127.0.0.1 on an ephemeral port, and
 * --profiling-enabled is never passed. k6's REST API is unauthenticated and can
 * change VU counts, so it must never listen on a routable address.
 *
 * WHAT IS AND IS NOT INSTANTANEOUS (verified against k6 v2.0.0):
 *   - http_reqs is a counter, so rps is derived from the DELTA between polls
 *   - http_req_failed exposes only a cumulative rate, but its denominator is the
 *     request count, so failed = rate * count and the delta gives an
 *     instantaneous error rate
 *   - vus is a gauge, already instantaneous
 *   - http_req_duration is a trend accumulated over the WHOLE RUN. Its
 *     percentiles cannot be de-cumulated, so p50/p90/p95 here are cumulative
 *     and the UI must say so. p(99) is absent entirely and comes from the
 *     end-of-run summary.
 *
 * Mirrors backend-go/internal/hera/progress.go.
 */

export interface HeraSample {
  /** Seconds since the run started. */
  t: number;
  vus: number;
  /** Instantaneous, from the request-count delta. */
  rps: number;
  /** Instantaneous, from the failed-count delta. */
  errorRatePct: number;
  /** Cumulative over the run so far — see the note above. */
  p50: number;
  p90: number;
  p95: number;
}

export const MAX_SAMPLES = 120;
export const POLL_MS = 1000;
const FETCH_TIMEOUT_MS = 2000;

/** Grab a free loopback port for k6's REST listener. */
export function pickLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not find a free port'))));
    });
  });
}

interface RawMetric {
  id?: string;
  attributes?: { sample?: Record<string, number> };
}

function sampleOf(raw: RawMetric[], id: string): Record<string, number> | undefined {
  return raw.find((m) => m.id === id)?.attributes?.sample;
}

export class ProgressCollector {
  private timer?: NodeJS.Timeout;
  private startedAt = Date.now();
  private acc: HeraSample[] = [];
  private prevAt = 0;
  private prevReqs = 0;
  private prevFailed = 0;
  /** Widens as samples are merged, so a long run still fits in MAX_SAMPLES. */
  private mergeGeneration = 0;

  constructor(private readonly port: number) {}

  start(): void {
    this.startedAt = Date.now();
    this.prevAt = this.startedAt;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Sample one more time (used right before the run is finalised). */
  async pollOnce(): Promise<void> {
    await this.poll();
  }

  get samples(): HeraSample[] {
    return this.acc;
  }

  private async poll(): Promise<void> {
    let raw: RawMetric[];
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/v1/metrics`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { data?: RawMetric[] };
      raw = body.data ?? [];
    } catch {
      // k6 has not opened the port yet, or has already exited. Both are normal.
      return;
    }

    const now = Date.now();
    const dtSec = Math.max(0.001, (now - this.prevAt) / 1000);

    const reqs = sampleOf(raw, 'http_reqs');
    const dur = sampleOf(raw, 'http_req_duration');
    const failed = sampleOf(raw, 'http_req_failed');
    const vus = sampleOf(raw, 'vus');

    const reqCount = reqs?.count ?? 0;
    const failRate = failed?.rate ?? 0;
    const failCount = failRate * reqCount;

    const dReqs = Math.max(0, reqCount - this.prevReqs);
    const dFailed = Math.max(0, failCount - this.prevFailed);

    this.push({
      t: Math.round((now - this.startedAt) / 1000),
      vus: Math.round(vus?.value ?? 0),
      rps: round2(dReqs / dtSec),
      errorRatePct: dReqs > 0 ? round2((dFailed / dReqs) * 100) : 0,
      p50: round2(dur?.med ?? 0),
      p90: round2(dur?.['p(90)'] ?? 0),
      p95: round2(dur?.['p(95)'] ?? 0),
    });

    this.prevAt = now;
    this.prevReqs = reqCount;
    this.prevFailed = failCount;
  }

  private push(s: HeraSample): void {
    this.acc.push(s);
    if (this.acc.length <= MAX_SAMPLES) return;
    // Merge adjacent pairs so the bucket width doubles instead of dropping the
    // tail. MAX is taken for latency and error rate: smoothing away a spike
    // would hide exactly the thing a load test is looking for.
    const merged: HeraSample[] = [];
    for (let i = 0; i < this.acc.length; i += 2) {
      const a = this.acc[i];
      const b = this.acc[i + 1];
      if (!b) {
        merged.push(a);
        continue;
      }
      merged.push({
        t: b.t,
        vus: b.vus,
        rps: Math.max(a.rps, b.rps),
        errorRatePct: Math.max(a.errorRatePct, b.errorRatePct),
        p50: Math.max(a.p50, b.p50),
        p90: Math.max(a.p90, b.p90),
        p95: Math.max(a.p95, b.p95),
      });
    }
    this.acc = merged;
    this.mergeGeneration++;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
