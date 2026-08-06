/**
 * The frozen document Hera reads back from k6.
 *
 * k6's own summary shape is version-coupled, so the extraction lives inside the
 * generated script's handleSummary (see prelude.ts) and both backends only ever
 * parse THIS shape. That collapses all k6-version risk into one string that the
 * script-parity fixture already covers.
 *
 * Mirrors backend-go/internal/hera/summary.go.
 */

export interface HeraTrend {
  min: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

export interface HeraStepStats {
  stepId: string;
  name: string;
  method: string;
  url: string;
  requests: number;
  errorRate: number;
  latency: HeraTrend | null;
  pollAttempts: HeraTrend | null;
  pollWaitMs: HeraTrend | null;
  scriptErrors: number;
}

export interface HeraRunSummary {
  requests: number;
  errorRate: number;
  rps: number;
  iterations: number;
  iterationDuration: HeraTrend | null;
  latency: HeraTrend | null;
  checksPassed: number;
  checksTotal: number;
  scriptErrors: number;
  suppressedGlobalWrites: number;
  dataSent: number;
  dataReceived: number;
  droppedIterations: number;
  vusMax: number;
}

export interface HeraSummaryDoc {
  heraSchema: number;
  summary: HeraRunSummary;
  steps: HeraStepStats[];
  thresholdsFailed: string[];
}

export const HERA_SUMMARY_SCHEMA = 1;

/**
 * Pull the summary out of k6's stdout.
 *
 * With `--quiet` the generated script's handleSummary is the only thing that
 * writes to stdout, but scan from the end anyway so a stray line cannot break
 * the parse.
 */
export function parseSummary(stdout: string): { doc: HeraSummaryDoc | null; error?: string } {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as HeraSummaryDoc;
      if (parsed && typeof parsed === 'object' && parsed.heraSchema === HERA_SUMMARY_SCHEMA) {
        return { doc: parsed };
      }
    } catch {
      // keep scanning — a partial line is not fatal
    }
  }
  return {
    doc: null,
    error:
      lines.length === 0
        ? 'k6 produced no output, so there is no summary to read.'
        : 'k6 produced output but no Hera summary line — the run most likely died before finishing.',
  };
}
