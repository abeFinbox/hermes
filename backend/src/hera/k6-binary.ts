import { execFile } from 'node:child_process';
import { heraLimits } from './config.js';

/**
 * k6 capability probe.
 *
 * The Docker image for the Go backend is distroless — no shell, no package
 * manager — so there is no way to introspect it except by asking the running
 * process. That makes this probe a hard requirement rather than a nicety: it is
 * also what lets a build without k6 (`--target runtime-slim`) degrade to a
 * disabled button instead of a 500 on submit.
 *
 * Mirrors backend-go/internal/hera/k6binary.go.
 */

export interface K6Capability {
  available: boolean;
  version: string | null;
  platform: string | null;
  /** Why it is unavailable — shown verbatim in the UI. */
  reason?: string;
}

const PROBE_TIMEOUT_MS = 5000;

// `k6 v2.0.0 (commit/devel, go1.26.3, darwin/arm64)`
const VERSION_RE = /^k6\s+(v[\d][^\s(]*)(?:.*?,\s*([a-z0-9]+\/[a-z0-9]+)\s*\))?/i;

let cached: Promise<K6Capability> | null = null;

export function parseK6Version(out: string): { version: string | null; platform: string | null } {
  const m = VERSION_RE.exec(out.trim());
  return { version: m?.[1] ?? null, platform: m?.[2] ?? null };
}

function probe(): Promise<K6Capability> {
  const bin = heraLimits().k6Bin || 'k6';
  return new Promise((resolve) => {
    execFile(bin, ['version'], { timeout: PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const reason =
          code === 'ENOENT'
            ? `k6 not found (looked for "${bin}"). Install k6 on the host running this backend, or set HERA_K6_BIN.`
            : `k6 could not be started: ${String(stderr || err.message).trim().split('\n')[0]}`;
        resolve({ available: false, version: null, platform: null, reason });
        return;
      }
      const { version, platform } = parseK6Version(String(stdout));
      if (!version) {
        resolve({
          available: false,
          version: null,
          platform: null,
          reason: `"${bin} version" produced unrecognised output: ${String(stdout).trim().slice(0, 120)}`,
        });
        return;
      }
      resolve({ available: true, version, platform });
    });
  });
}

/** Cached probe — a binary does not appear mid-process. */
export function k6Capability(): Promise<K6Capability> {
  if (!cached) cached = probe();
  return cached;
}

/** Drop the cache so the next call re-probes (used by the UI's "recheck"). */
export function resetK6Capability(): void {
  cached = null;
}
