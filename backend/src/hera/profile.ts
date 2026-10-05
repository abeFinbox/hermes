/**
 * Load profiles: the SHAPE of a run, derived from the two numbers the user
 * already gives (virtual users and duration).
 *
 * A mode never invents its own numbers. `vus` stays the peak and `durationSec`
 * stays the total, so every existing cap — HERA_MAX_VUS, HERA_MAX_DURATION_SEC,
 * the rps x duration request ceiling — keeps applying unchanged, and switching
 * mode can never smuggle more load past them than the flat run would.
 *
 * Stage seconds are integers and always sum to EXACTLY durationSec: the
 * remainder after the percentage split is given to the hold stage, never
 * distributed. Two implementations that round differently would emit different
 * scripts, which is what the script-parity fixture is there to catch.
 *
 * Mirrors backend-go/internal/hera/profile.go.
 */

export type HeraMode = 'constant' | 'smoke' | 'load' | 'stress' | 'spike' | 'soak' | 'rate';

/** Declared in one place, in display order; the UI dropdown follows it. */
export const HERA_MODES: HeraMode[] = ['constant', 'smoke', 'load', 'stress', 'spike', 'soak', 'rate'];

export function isHeraMode(v: unknown): v is HeraMode {
  return typeof v === 'string' && (HERA_MODES as string[]).includes(v);
}

export interface HeraStage {
  /** Whole seconds. */
  durationSec: number;
  /** Virtual users to reach by the end of this stage. */
  target: number;
}

export interface HeraProfile {
  mode: HeraMode;
  /** Peak virtual users. For smoke this is 1, whatever was requested. */
  vus: number;
  /** Total run length; the stages always sum to this. */
  durationSec: number;
  /** Empty for the flat modes, which use plain vus + duration instead. */
  stages: HeraStage[];
  /** Arrival rate per second; set only for 'rate', which pins throughput. */
  ratePerSec: number | null;
  /** Human explanation of the shape, shown in the launch form and on the run. */
  summary: string;
  /** Why the requested shape was not used verbatim, if it was not. */
  notes: string[];
}

/**
 * Shortest run each shape needs to be meaningful. Below it the shape would
 * collapse into stages of zero or one second, which is noise rather than a ramp,
 * so the mode falls back to a flat run and says so.
 */
const MIN_SEC: Record<HeraMode, number> = {
  constant: 1,
  smoke: 1,
  load: 5,
  stress: 8,
  spike: 10,
  soak: 1,
  rate: 1,
};

export const HERA_MODE_LABELS: Record<HeraMode, string> = {
  constant: 'Constant — flat load, the whole run at once',
  smoke: 'Smoke — one virtual user, does it work at all',
  load: 'Load — ramp up, hold, ramp down',
  stress: 'Stress — step up in four stages to find the knee',
  spike: 'Spike — a sudden surge on top of a low baseline',
  soak: 'Soak — hold steady for a long time, watch for drift',
  rate: 'Rate — pin iterations per second, whatever it costs in VUs',
};

/**
 * True when the schedule lives in the script's own options rather than in plain
 * vus + duration. Those runs must NOT be given a --duration flag: on the CLI it
 * wins and silently flattens the shape. One rule, read by both the generator and
 * the spawner.
 */
export function schedulesInScript(p: HeraProfile): boolean {
  return p.ratePerSec !== null || p.stages.length > 0;
}

/** Integer seconds for a percentage of the total. */
function pct(total: number, p: number): number {
  return Math.floor((total * p) / 100);
}

/** At least one VU, for the low shoulders of a spike. */
function share(vus: number, p: number): number {
  return Math.max(1, Math.floor((vus * p) / 100));
}

/**
 * `rps` is the ceiling the server allows. `targetRps` is what the operator asked
 * for in rate mode; it is clamped to the ceiling by the caller, and defaults to
 * the ceiling when absent, which is what every pre-existing config does.
 */
export function deriveProfile(mode: HeraMode, vus: number, durationSec: number, rps: number, targetRps?: number | null): HeraProfile {
  const notes: string[] = [];
  let m: HeraMode = mode;
  if (durationSec < MIN_SEC[m]) {
    notes.push(
      `${m} needs at least ${MIN_SEC[m]}s to have a shape, so this run is flat instead. Raise the duration to use it.`,
    );
    m = 'constant';
  }

  const flat = (summary: string, atVus = vus): HeraProfile => ({
    mode: m,
    vus: atVus,
    durationSec,
    stages: [],
    ratePerSec: null,
    summary,
    notes,
  });

  switch (m) {
    case 'smoke': {
      if (vus > 1) notes.push('Smoke runs a single virtual user; the requested count is ignored.');
      return flat(`1 virtual user for ${durationSec}s.`, 1);
    }

    case 'soak':
      return flat(
        `${vus} ${vus === 1 ? 'virtual user' : 'virtual users'} held for ${durationSec}s. A real soak wants tens of minutes — raise HERA_MAX_DURATION_SEC if this is capped short.`,
      );

    case 'rate': {
      const rate = Math.max(1, Math.min(rps, Math.trunc(Number(targetRps) || rps)));
      if (targetRps !== undefined && targetRps !== null && Math.trunc(Number(targetRps)) > rps) {
        notes.push(`Rate reduced from ${Math.trunc(Number(targetRps))} to ${rps} iterations/s (HERA_MAX_RPS).`);
      }
      return {
        mode: m,
        vus,
        durationSec,
        stages: [],
        ratePerSec: rate,
        summary: `${rate} iterations/s — one full pass through the suite each — for ${durationSec}s, using up to ${vus} virtual users. Dropped iterations mean the rate could not be met.`,
        notes,
      };
    }

    case 'load': {
      const up = pct(durationSec, 20);
      const down = pct(durationSec, 20);
      const hold = durationSec - up - down;
      return {
        mode: m,
        vus,
        durationSec,
        stages: [
          { durationSec: up, target: vus },
          { durationSec: hold, target: vus },
          { durationSec: down, target: 0 },
        ],
        ratePerSec: null,
        summary: `0→${vus} over ${up}s, hold ${hold}s, ${vus}→0 over ${down}s.`,
        notes,
      };
    }

    case 'stress': {
      const step = pct(durationSec, 25);
      const last = durationSec - step * 3;
      const t1 = share(vus, 25);
      const t2 = share(vus, 50);
      const t3 = share(vus, 75);
      return {
        mode: m,
        vus,
        durationSec,
        stages: [
          { durationSec: step, target: t1 },
          { durationSec: step, target: t2 },
          { durationSec: step, target: t3 },
          { durationSec: last, target: vus },
        ],
        ratePerSec: null,
        summary: `Steps of ~${step}s to ${t1}, ${t2}, ${t3}, then ${vus} virtual users. Watch which step the latency turns at.`,
        notes,
      };
    }

    case 'spike': {
      const base = pct(durationSec, 25);
      const rise = pct(durationSec, 5);
      const recover = pct(durationSec, 25);
      const hold = durationSec - base - rise - recover;
      const low = share(vus, 10);
      return {
        mode: m,
        vus,
        durationSec,
        stages: [
          { durationSec: base, target: low },
          { durationSec: rise, target: vus },
          { durationSec: hold, target: vus },
          { durationSec: recover, target: low },
        ],
        ratePerSec: null,
        summary: `${low} ${low === 1 ? 'virtual user' : 'virtual users'} for ${base}s, surge to ${vus} in ${rise}s, hold ${hold}s, back to ${low} over ${recover}s.`,
        notes,
      };
    }

    default:
      return flat(`${vus} ${vus === 1 ? 'virtual user' : 'virtual users'} for ${durationSec}s.`);
  }
}
