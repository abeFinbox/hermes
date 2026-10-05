/**
 * Dynamic variables: `{{$guid}}`, `{{$timestamp}}` and friends.
 *
 * These are generated at resolve time rather than looked up in a scope, which is
 * what makes them useful for the two things people kept hand-rolling with a
 * seed step: a fresh id per request, and "now" in a payload.
 *
 * Evaluated PER OCCURRENCE, like Postman: two `{{$guid}}` in one body are two
 * different UUIDs, and the same token in step 1 and step 5 differs. To send one
 * value in several places, capture it once (`variables.set("link_id", ...)`, or
 * a visual capture) and use `{{link_id}}` from then on.
 *
 * A user variable can never collide with one of these: variable names must match
 * /^[A-Za-z_]/ everywhere they are accepted, so a leading `$` is impossible.
 *
 * Kept identical in backend-go/internal/dynvars/dynvars.go and, as JS, in the
 * k6 prelude (backend/src/hera/prelude.ts) so a load test generates the same
 * shapes per virtual user.
 */

/** One dynamic variable: the token name (without `$`) and what it produces. */
export interface DynamicVarSpec {
  name: string;
  /** Shown in the UI chip tooltip and in the docs table. */
  description: string;
  /** Example rendering, for docs/tooltips only — never used as a value. */
  example: string;
}

export const DYNAMIC_VARS: DynamicVarSpec[] = [
  { name: '$guid', description: 'Random UUID v4 — a fresh id per request', example: '3f2b9c74-5e41-4a8f-b0d2-9c1e77a4e5b3' },
  { name: '$randomInt', description: 'Random integer, 0–1000', example: '742' },
  { name: '$randomHex', description: '16 random hex characters', example: 'a3f19c02b7d45e68' },
  { name: '$timestamp', description: 'Current Unix time in seconds', example: '1788945353' },
  { name: '$epochMillis', description: 'Current Unix time in milliseconds', example: '1788945353514' },
  { name: '$isoTimestamp', description: "Current UTC time, ISO 8601", example: '2026-09-09T09:15:53.514Z' },
  { name: '$date', description: "Today's date in UTC, YYYY-MM-DD", example: '2026-09-09' },
];

const DYNAMIC_NAMES = new Set(DYNAMIC_VARS.map((d) => d.name));

/** True when `key` is one of the dynamic variables (leading `$` included). */
export function isDynamicVar(key: string): boolean {
  return DYNAMIC_NAMES.has(key);
}

function hex(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/**
 * UUID v4 built from Math.random.
 *
 * Not crypto-strong, and deliberately so: this is the same generator the k6
 * prelude and the Go backend use, and a test id does not need unpredictability —
 * it needs to be different every time and identical in shape everywhere.
 */
function uuidV4(): string {
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16); // 8, 9, a or b
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

/** Value for one dynamic variable, or undefined when the name is not one. */
export function dynamicVarValue(key: string, now: Date = new Date()): string | undefined {
  switch (key) {
    case '$guid': return uuidV4();
    case '$randomInt': return String(Math.floor(Math.random() * 1001));
    case '$randomHex': return hex(16);
    case '$timestamp': return String(Math.floor(now.getTime() / 1000));
    case '$epochMillis': return String(now.getTime());
    case '$isoTimestamp': return now.toISOString();
    case '$date': return now.toISOString().slice(0, 10);
    default: return undefined;
  }
}

/**
 * Stable stand-in used where a value must NOT vary: preflight target
 * validation and the statically-resolved cURL.
 *
 * A host that depends on a random token cannot be validated (it would resolve
 * to something different at run time), and the parity harness compares two
 * engines byte for byte — a live UUID there would make every run differ.
 */
export function dynamicVarPlaceholder(key: string): string | undefined {
  switch (key) {
    case '$guid': return '00000000-0000-4000-8000-000000000000';
    case '$randomInt': return '0';
    case '$randomHex': return '0000000000000000';
    case '$timestamp': return '0';
    case '$epochMillis': return '0';
    case '$isoTimestamp': return '1970-01-01T00:00:00.000Z';
    case '$date': return '1970-01-01';
    default: return undefined;
  }
}
