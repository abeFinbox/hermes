import type { HeraLimits } from './config.js';
import { dynamicVarPlaceholder } from '../dynamic-vars.js';

/**
 * Target validation: what Hera is allowed to point load at.
 *
 * This is the security boundary of the whole feature. Hera turns an
 * authenticated web app into a load generator aimed at any URL the host can
 * reach, so:
 *
 *   - the allow-list is DEFAULT-DENY. With no HERA_TARGET_ALLOW, the only
 *     permitted target is this instance's own /mock demo API.
 *   - the deny-list is HARDCODED and cannot be widened by configuration.
 *     Env vars get copy-pasted between environments; cloud metadata must not
 *     become reachable because someone pasted a permissive value.
 *   - hosts are RESOLVED and PINNED before the run. A name check alone is
 *     worthless: evil.example.com can resolve to 169.254.169.254, and it can
 *     resolve differently on the second lookup (DNS rebinding).
 *
 * Every rejection message here is part of the cross-backend contract — the
 * parity fixture asserts Node and Go produce identical strings, because a
 * divergence would mean one backend is a bypass for the other.
 * Mirrors backend-go/internal/hera/target.go.
 */

export interface ResolvedTarget {
  ok: boolean;
  reason?: string;
  /** Host as written, after variable resolution. */
  host?: string;
  port?: string;
  scheme?: string;
  /** The IP the script is pinned to, so k6 never re-resolves. */
  resolvedIp?: string;
  /** All addresses the host resolved to, for the audit trail. */
  allIps?: string[];
  /** True when this is the deliberate self-/mock exception. */
  selfMock?: boolean;
}

export type ResolveFn = (host: string) => Promise<string[]>;

export interface TargetOptions {
  limits: HeraLimits;
  /** This instance's own listening port, for the self-origin rule. */
  selfPort: string;
  resolve: ResolveFn;
}

const TOKEN_RE = /\{\{\s*([^}\s]+)\s*\}\}/g;

/**
 * Mirrors VarScope.resolve: up to 5 passes, unknown tokens left literal.
 *
 * Dynamic variables (`{{$guid}}` etc.) are left literal too, on purpose: this
 * function feeds the preflight PREVIEW, and a URL that reads
 * `.../items?id={{$guid}}` is more honest than one showing a UUID that will not
 * be the one sent. Preflight already reports such tokens as runtime tokens.
 * Host validation uses interpolateForTarget instead — see below.
 */
export function interpolate(text: string, vars: Record<string, string>): string {
  let out = String(text ?? '');
  for (let pass = 0; pass < 5; pass++) {
    if (!out.includes('{{')) break;
    const before = out;
    out = out.replace(TOKEN_RE, (whole, key: string) => (vars[key] === undefined ? whole : vars[key]));
    if (out === before) break;
  }
  return out;
}

/**
 * Interpolation used to decide WHERE a request goes.
 *
 * Same as interpolate, except dynamic variables collapse to a fixed placeholder
 * (dynamicVarPlaceholder). Two reasons: a host must be validated and pinned to
 * one IP before the run starts, which is impossible if part of it is random; and
 * the target parity harness compares both engines byte for byte, so a live UUID
 * in here would make every comparison fail.
 */
export function interpolateForTarget(text: string, vars: Record<string, string>): string {
  let out = String(text ?? '');
  for (let pass = 0; pass < 5; pass++) {
    if (!out.includes('{{')) break;
    const before = out;
    out = out.replace(TOKEN_RE, (whole, key: string) => {
      const placeholder = dynamicVarPlaceholder(key);
      if (placeholder !== undefined) return placeholder;
      return vars[key] === undefined ? whole : vars[key];
    });
    if (out === before) break;
  }
  return out;
}

/** Hostnames that are cloud metadata services by name rather than by address. */
const METADATA_HOSTS = new Set(['metadata', 'metadata.google.internal', 'metadata.goog']);

interface DenyRange {
  label: string;
  match: (ip: string) => boolean;
}

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

function normaliseIpv6(ip: string): string {
  return ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
}

/**
 * Permanently blocked ranges. NOT configurable — see the module comment.
 * The link-local case is the important one: without it an authenticated user
 * can read cloud IAM credentials through a "load test".
 */
const HARD_DENY: DenyRange[] = [
  {
    label: 'cloud metadata',
    match: (ip) => {
      const p = ipv4Parts(ip);
      if (p) return (p[0] === 169 && p[1] === 254) || ip === '100.100.100.200' || ip === '192.0.0.192';
      return false;
    },
  },
  {
    label: 'IPv6 link-local',
    match: (ip) => {
      const v6 = normaliseIpv6(ip);
      return /^fe[89ab][0-9a-f]:/.test(v6);
    },
  },
  {
    label: 'IPv6 unique-local',
    match: (ip) => /^f[cd][0-9a-f]{2}:/.test(normaliseIpv6(ip)),
  },
  {
    label: 'unspecified address',
    match: (ip) => {
      const p = ipv4Parts(ip);
      if (p) return p[0] === 0;
      return normaliseIpv6(ip) === '::';
    },
  },
];

export function isLoopback(ip: string): boolean {
  const p = ipv4Parts(ip);
  if (p) return p[0] === 127;
  const v6 = normaliseIpv6(ip);
  return v6 === '::1';
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const a = ipv4Parts(ip);
  const b = ipv4Parts(net);
  if (!a || !b || !Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const toInt = (q: number[]) => ((q[0] << 24) | (q[1] << 16) | (q[2] << 8) | q[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(a) & mask) === (toInt(b) & mask);
}

/** Allow-list entry forms: exact host, host:port, *.suffix, or a CIDR. */
function matchesAllow(entry: string, host: string, port: string, ips: string[]): boolean {
  const h = host.toLowerCase();
  if (entry.includes('/')) return ips.some((ip) => ipInCidr(ip, entry));
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1); // ".example.com"
    return h.endsWith(suffix);
  }
  if (entry.includes(':')) return entry === h + ':' + port;
  return entry === h;
}

export function validateTarget(
  rawUrl: string,
  vars: Record<string, string>,
  opts: TargetOptions,
): Promise<ResolvedTarget> {
  return validate(interpolateForTarget(rawUrl, vars), opts);
}

const TEMPLATED_ORIGIN =
  'The target host still contains {{...}} after variable resolution, so it cannot be checked against the allow-list. Define the variable, or hard-code the host.';

/**
 * Does the ORIGIN (not the path) still hold a template?
 *
 * Checked before parsing, because the two languages' URL parsers disagree about
 * a host containing braces: new URL() accepts it, Go's url.Parse rejects it. A
 * templated path like /mock/job/{{jobId}} is perfectly fine and must pass.
 */
export function originHasTemplate(raw: string): boolean {
  const sep = raw.indexOf('://');
  if (sep === -1) return false;
  const after = raw.slice(sep + 3);
  const slash = after.indexOf('/');
  const origin = slash === -1 ? after : after.slice(0, slash);
  return origin.includes('{{') || origin.includes('}}');
}

async function validate(url: string, opts: TargetOptions): Promise<ResolvedTarget> {
  if (originHasTemplate(url)) return { ok: false, reason: TEMPLATED_ORIGIN };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `Target is not an absolute http(s) URL: ${url}` };
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return { ok: false, reason: `Only http and https targets are allowed (got "${scheme}").` };
  }

  // Strip the brackets new URL() keeps around an IPv6 literal; Go's Hostname()
  // does not, and the host appears verbatim in messages that must match.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: `Target is not an absolute http(s) URL: ${url}` };
  const port = parsed.port || (scheme === 'https' ? '443' : '80');

  if (METADATA_HOSTS.has(host)) {
    return { ok: false, reason: `Target "${host}" is a cloud metadata endpoint and is permanently blocked.` };
  }

  let ips: string[];
  const literal = ipv4Parts(host) !== null || host.includes(':');
  if (literal) {
    ips = [host];
  } else {
    try {
      ips = await opts.resolve(host);
    } catch {
      // The underlying resolver message differs between Node and Go, so it is
      // deliberately not included — the string is part of the parity contract.
      return { ok: false, reason: `Could not resolve host "${host}".` };
    }
    if (ips.length === 0) return { ok: false, reason: `Could not resolve host "${host}".` };
  }

  // Check EVERY address, not just the first: a name that resolves to one good
  // and one blocked address must be rejected.
  for (const ip of ips) {
    for (const range of HARD_DENY) {
      if (range.match(ip)) {
        return {
          ok: false,
          reason: `Target "${host}" resolves to ${ip}, which is in a permanently blocked range (${range.label}).`,
        };
      }
    }
  }

  // The self-origin rule: hammering our own API takes the UI down with it, and
  // /mock is the one path that is safe (and is the default-deny target).
  const isSelfOrigin = ips.some(isLoopback) && port === opts.selfPort;
  const path = parsed.pathname || '/';
  const isMockPath = path === '/mock' || path.startsWith('/mock/');
  if (isSelfOrigin && !isMockPath) {
    return {
      ok: false,
      reason: `Pointing Hera at this Hermes instance is only allowed under /mock (got "${path}") — load-testing your own API takes the UI down with it.`,
    };
  }

  const allow = opts.limits.targetAllow;
  const allowed = isSelfOrigin && isMockPath ? true : allow.some((e) => matchesAllow(e, host, port, ips));
  if (!allowed) {
    if (allow.length === 0) {
      return {
        ok: false,
        reason: `No HERA_TARGET_ALLOW is configured, so Hera may only target this instance's own /mock API. Set HERA_TARGET_ALLOW to load-test "${host}".`,
      };
    }
    return { ok: false, reason: `Target host "${host}" is not in HERA_TARGET_ALLOW.` };
  }

  return {
    ok: true,
    host,
    port,
    scheme,
    resolvedIp: ips[0],
    allIps: ips,
    selfMock: isSelfOrigin && isMockPath,
  };
}
