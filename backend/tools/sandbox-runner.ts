// Node half of the sandbox parity harness. Reads the shared cases file and
// runs each case through the REAL (older) node:vm sandbox, emitting the same
// JSON shape the Go/goja runner produces so the two outputs can be diffed.
//
//   npx tsx tools/sandbox-runner.ts ../backend-go/testdata/sandbox-cases.json
import { readFileSync } from 'node:fs';
import { runScript, type SandboxResponse } from '../src/runner/sandbox.js';

interface TestCase {
  name: string;
  code: string;
  mode: 'capture' | 'validate';
  response: SandboxResponse;
  variables: Record<string, string>;
}

const path = process.argv[2];
if (!path) {
  console.error('usage: tsx tools/sandbox-runner.ts <cases.json>');
  process.exit(2);
}

const cases: TestCase[] = JSON.parse(readFileSync(path, 'utf8'));

const results = cases.map((c) => {
  const getVariable = (key: string): string | undefined =>
    Object.prototype.hasOwnProperty.call(c.variables, key) ? c.variables[key] : undefined;
  const outcome = runScript(c.code, c.response, getVariable, c.mode);
  return { name: c.name, outcome };
});

process.stdout.write(JSON.stringify(results, null, 2) + '\n');
