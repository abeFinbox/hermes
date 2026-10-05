/**
 * Node half of the Hera cURL-parity harness. Reads the shared cases file and
 * emits the cURL built for each step, so the two builders can be diffed. The Go
 * half is backend-go/cmd/hera-curl-runner and must produce BYTE-IDENTICAL output.
 *
 * A divergence here is not cosmetic: this command carries real credentials and is
 * what someone pastes into a terminal to reproduce a failing step. If the two
 * engines quote, order or percent-encode differently, one of them is handing out
 * a command that does not reproduce the run.
 *
 *   npx tsx tools/hera-curl-runner.ts ../backend-go/testdata/hera-curl-cases.json
 */
import { readFileSync } from 'node:fs';
import { buildStepCurl } from '../src/hera/curl.js';
import { emptyRequest, type Step } from '../src/types.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: hera-curl-runner <cases.json>');
  process.exit(2);
}

interface Case {
  name: string;
  seedVars?: Record<string, string>;
  fileMeta?: Record<string, { filename: string; mime: string }>;
  hostHeader?: string;
  step: Record<string, any>;
}

/** Fill a fixture step out to a full Step. Mirrors hydrateStep in the Go half. */
function hydrateStep(raw: Record<string, any>): Step {
  const req = { ...emptyRequest(), ...(raw.request || {}) };
  return {
    id: raw.id || 'step-1',
    name: raw.name || 'Step',
    enabled: raw.enabled !== false,
    folderPath: raw.folderPath || '',
    request: {
      method: req.method || 'GET',
      url: req.url || '',
      headers: req.headers || [],
      params: req.params || [],
      body: { mode: req.body?.mode || 'none', content: req.body?.content || '', formData: req.body?.formData },
      auth: req.auth || { type: 'none' },
    },
    validations: { visual: [], script: '' },
    captures: { visual: [], script: '' },
  };
}

const cases: Case[] = JSON.parse(readFileSync(file, 'utf8'));
const lines: string[] = [];

for (const c of cases) {
  lines.push('--- ' + c.name);
  const curl = buildStepCurl({
    step: hydrateStep(c.step),
    seedVars: c.seedVars || {},
    fileMeta: c.fileMeta || {},
    hostHeader: c.hostHeader,
  });
  // Indent so a multi-line command cannot be confused with the next case label.
  for (const l of curl.split('\n')) lines.push('  ' + l);
}

process.stdout.write(lines.join('\n') + '\n');
