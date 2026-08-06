/**
 * Node half of the Hera target-validation parity harness. DNS is stubbed from
 * the fixture, so this needs no network and is deterministic.
 *
 * Rejection-string parity matters more than script parity: a divergence between
 * the two backends means one is a bypass for the other.
 *
 *   npx tsx tools/hera-target-runner.ts ../backend-go/testdata/hera-target-cases.json
 */
import { readFileSync } from 'node:fs';
import { validateTarget } from '../src/hera/target.js';
import { heraLimits } from '../src/hera/config.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: hera-target-runner <target-cases.json>');
  process.exit(2);
}

interface Fixture {
  selfPort: string;
  dns: Record<string, string[]>;
  cases: Array<{ name: string; url: string; allow: string[]; vars?: Record<string, string> }>;
}

const fx: Fixture = JSON.parse(readFileSync(file, 'utf8'));
const lines: string[] = [];

for (const c of fx.cases) {
  const limits = { ...heraLimits(), targetAllow: c.allow };
  const res = await validateTarget(c.url, c.vars || {}, {
    limits,
    selfPort: fx.selfPort,
    resolve: async (host: string) => {
      const ips = fx.dns[host];
      if (!ips) throw new Error('stub NXDOMAIN');
      return ips;
    },
  });
  lines.push('--- ' + c.name);
  lines.push('  url    : ' + c.url);
  lines.push('  allow  : ' + JSON.stringify(c.allow));
  lines.push('  ok     : ' + String(res.ok));
  lines.push('  reason : ' + (res.reason ?? ''));
  lines.push('  host   : ' + (res.host ?? ''));
  lines.push('  port   : ' + (res.port ?? ''));
  lines.push('  pinned : ' + (res.resolvedIp ?? ''));
  lines.push('  allIps : ' + JSON.stringify(res.allIps ?? []));
  lines.push('  selfMock: ' + String(res.selfMock === true));
}

process.stdout.write(lines.join('\n') + '\n');
