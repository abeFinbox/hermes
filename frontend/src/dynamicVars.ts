/**
 * Dynamic variables the runner generates at send time — the UI copy of the
 * table in backend/src/dynamic-vars.ts (and backend-go/internal/dynvars).
 *
 * Only used for display: to render `{{$guid}}` as a "dynamic" chip instead of an
 * undefined one, and to tell the reader what it will produce. Values are always
 * generated server-side, per occurrence, so nothing here computes anything.
 */

export interface DynamicVarSpec {
  name: string;
  description: string;
  example: string;
}

export const DYNAMIC_VARS: DynamicVarSpec[] = [
  { name: '$guid', description: 'Random UUID v4 — a fresh id per request', example: '3f2b9c74-5e41-4a8f-b0d2-9c1e77a4e5b3' },
  { name: '$randomInt', description: 'Random integer, 0–1000', example: '742' },
  { name: '$randomHex', description: '16 random hex characters', example: 'a3f19c02b7d45e68' },
  { name: '$timestamp', description: 'Current Unix time in seconds', example: '1788945353' },
  { name: '$epochMillis', description: 'Current Unix time in milliseconds', example: '1788945353514' },
  { name: '$isoTimestamp', description: 'Current UTC time, ISO 8601', example: '2026-09-09T09:15:53.514Z' },
  { name: "$date", description: "Today's date in UTC, YYYY-MM-DD", example: '2026-09-09' },
];

const BY_NAME = new Map(DYNAMIC_VARS.map((d) => [d.name, d]));

export function dynamicVar(name: string): DynamicVarSpec | undefined {
  return BY_NAME.get(name);
}

export function isDynamicVar(name: string): boolean {
  return BY_NAME.has(name);
}
