/**
 * Node half of the Hera script-parity harness. Reads the shared cases file and
 * emits the generated k6 script for each case, so the two generators' output can
 * be diffed. The Go half is backend-go/cmd/hera-script-runner and must produce
 * BYTE-IDENTICAL output.
 *
 *   npx tsx tools/hera-script-runner.ts ../backend-go/testdata/hera-cases.json
 */
import { readFileSync } from 'node:fs';
import { generateScript } from '../src/hera/script.js';
import { defaultSettings, emptyRequest, type Step, type Suite } from '../src/types.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: hera-script-runner <cases.json>');
  process.exit(2);
}

interface Case {
  name: string;
  seedVars?: Record<string, string>;
  load: { vus: number; durationSec: number; rps: number; thinkTimeMs: number; p95Ms: number | null; errorRatePct: number | null };
  filePaths?: Record<string, string>;
  fileMeta?: Record<string, { filename: string; mime: string }>;
  hostHeader?: string;
  /** hostname -> IP for the options.hosts DNS pin. */
  hosts?: Record<string, string>;
  /** Failure-diagnostic knobs; omitted means off, as on a default instance. */
  diag?: { enabled: boolean; max: number; body: boolean; bodyMax: number };
  suite: {
    name: string;
    settings?: Partial<Suite['settings']>;
    variables?: Suite['variables'];
    steps: Array<Record<string, any>>;
  };
}

/** Fill a fixture step out to a full Step, so fixtures stay readable. */
function hydrateStep(raw: Record<string, any>): Step {
  const req = { ...emptyRequest(), ...(raw.request || {}) };
  return {
    id: raw.id,
    name: raw.name,
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
    validations: { visual: raw.validations?.visual || [], script: raw.validations?.script || '' },
    captures: { visual: raw.captures?.visual || [], script: raw.captures?.script || '' },
    polling: raw.polling,
  };
}

const cases: Case[] = JSON.parse(readFileSync(file, 'utf8'));
const chunks: string[] = [];

for (const c of cases) {
  const suite: Suite = {
    id: 'fixture',
    name: c.suite.name,
    description: '',
    collectionId: null,
    steps: c.suite.steps.map(hydrateStep),
    variables: c.suite.variables || [],
    settings: { ...defaultSettings(), ...(c.suite.settings || {}) },
    createdAt: '',
    updatedAt: '',
  };
  const { script } = generateScript({
    suite,
    seedVars: c.seedVars || {},
    load: c.load,
    filePaths: c.filePaths || {},
    fileMeta: c.fileMeta || {},
    hostHeader: c.hostHeader,
    hosts: c.hosts,
    diag: c.diag,
  });
  chunks.push('===== CASE ' + c.name + ' =====\n' + script);
}

process.stdout.write(chunks.join('\n') + '\n');
