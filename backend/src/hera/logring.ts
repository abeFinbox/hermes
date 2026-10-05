/**
 * Bounded, in-memory ring of k6 output lines for the live log panel.
 *
 * Why a ring and not the database: k6 can emit thousands of lines in a minute,
 * and writing them through SQLite every 2s would turn a load test into a write
 * benchmark. What survives the run is the existing 64KB stderr_tail column; the
 * ring is only the live view, and it dies with the process that owns the run.
 *
 * Line numbers are a MONOTONIC cursor, never reset and never reused, so a
 * client polling with ?sinceLine= keeps working across eviction: it asks for
 * "after 900", gets whatever of that is still retained, and learns from
 * firstLine that lines 1..N are gone rather than silently seeing a shorter log.
 *
 * Mirrors backend-go/internal/hera/logring.go — the eviction order (lines
 * first, then bytes) and the redaction rules must match, or the two engines
 * report different `dropped` counts for the same run.
 */

import { MAX_LOG_RING_BYTES } from './config.js';

export interface LogLine {
  /** 1-based monotonic position in the run's output. */
  n: number;
  /** k6's own timestamp, or '' for a line that was not JSON. */
  t: string;
  /** error | warning | info | debug, or 'raw' when the line was not JSON. */
  level: string;
  msg: string;
}

export interface LogSlice {
  lines: LogLine[];
  /** Total lines ever appended. Pass back as ?sinceLine= to resume. */
  cursor: number;
  /** Position of the oldest retained line; 0 when nothing is retained. */
  firstLine: number;
  /** Lines evicted since the run started. */
  dropped: number;
}

/**
 * Strip credentials that k6 may echo. Metrics sink URLs reach k6 as env vars
 * and come back out in connection errors, so this runs before storage: the API
 * response and the persisted tail are then both clean.
 */
export function redactLine(s: string): string {
  return s
    .replace(/\/\/[^/@\s:]+:[^/@\s]*@/g, '//***@')
    .replace(/((?:password|passwd|token|secret|apikey|api_key)["']?\s*[=:]\s*["']?)[^"'\s,&}]+/gi, '$1***');
}

/** Parse one k6 --log-format json line; fall back to keeping it verbatim. */
function parseLine(n: number, raw: string): LogLine {
  const trimmed = raw.replace(/\r$/, '');
  if (trimmed.startsWith('{')) {
    try {
      const doc = JSON.parse(trimmed) as Record<string, unknown>;
      if (doc && typeof doc === 'object' && typeof doc.msg === 'string') {
        return {
          n,
          t: typeof doc.time === 'string' ? doc.time : '',
          level: typeof doc.level === 'string' ? doc.level.toLowerCase() : 'info',
          msg: redactLine(doc.msg),
        };
      }
    } catch {
      /* not JSON after all; fall through and keep the raw text */
    }
  }
  return { n, t: '', level: 'raw', msg: redactLine(trimmed) };
}

export class LogRing {
  private lines: LogLine[] = [];
  private bytes = 0;
  private appended = 0;
  private evicted = 0;

  constructor(
    private readonly maxLines: number,
    private readonly maxBytes: number = MAX_LOG_RING_BYTES,
  ) {}

  push(raw: string): void {
    if (raw === '') return;
    this.appended += 1;
    const line = parseLine(this.appended, raw);
    this.lines.push(line);
    this.bytes += line.msg.length + line.t.length + line.level.length;
    while (this.lines.length > this.maxLines || (this.bytes > this.maxBytes && this.lines.length > 1)) {
      const gone = this.lines.shift();
      if (!gone) break;
      this.bytes -= gone.msg.length + gone.t.length + gone.level.length;
      this.evicted += 1;
    }
  }

  since(sinceLine: number): LogSlice {
    const from = Number.isFinite(sinceLine) && sinceLine > 0 ? Math.floor(sinceLine) : 0;
    return {
      lines: this.lines.filter((l) => l.n > from),
      cursor: this.appended,
      firstLine: this.lines.length ? this.lines[0].n : 0,
      dropped: this.evicted,
    };
  }
}

/**
 * Build a LogSlice from a finished run's stderr_tail, so the same route answers
 * for live and terminal runs. Numbering restarts at 1 — the tail is a suffix of
 * the output, so its line numbers cannot be the live cursor's, and pretending
 * otherwise would let a client stitch two incompatible numberings together.
 */
export function sliceFromTail(tail: string): LogSlice {
  if (tail === '') return { lines: [], cursor: 0, firstLine: 0, dropped: 0 };
  const raw = tail.split('\n');
  // A trailing newline yields a final empty element that is not a line.
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const lines = raw.map((s, i) => parseLine(i + 1, s));
  return { lines, cursor: lines.length, firstLine: lines.length ? 1 : 0, dropped: 0 };
}
