import vm from 'node:vm';
import type { AssertionResult } from '../types.js';

/**
 * Sandbox for user-authored capture & validation scripts.
 * v1 uses node:vm with a frozen, minimal context and a hard timeout.
 * NOTE: node:vm is not a hard security boundary; for untrusted multi-tenant
 * use, swap this module for an isolated-vm implementation (same interface).
 */

export interface SandboxResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  time: number; // ms
  bodyText: string;
}

export interface SandboxOutcome {
  tests: AssertionResult[];
  logs: string[];
  setVariables: Array<{ key: string; value: string; scope: 'suite' | 'global' | 'runtime' }>;
  failed: boolean;
  error?: string;
}

const TIMEOUT_MS = 2000;

export function runScript(
  code: string,
  response: SandboxResponse,
  getVariable: (key: string) => string | undefined,
  mode: 'capture' | 'validate',
): SandboxOutcome {
  const outcome: SandboxOutcome = { tests: [], logs: [], setVariables: [], failed: false };
  if (!code || !code.trim()) return outcome;

  let parsedJson: unknown;
  let jsonParsed = false;

  const responseApi = Object.freeze({
    status: response.status,
    statusText: response.statusText,
    headers: Object.freeze({ ...response.headers }),
    time: response.time,
    json: () => {
      if (!jsonParsed) {
        parsedJson = JSON.parse(response.bodyText);
        jsonParsed = true;
      }
      return parsedJson;
    },
    text: () => response.bodyText,
    header: (name: string) => response.headers[String(name).toLowerCase()],
  });

  const variablesApi = Object.freeze({
    get: (key: string) => getVariable(String(key)),
    set: (key: string, value: unknown, scope?: string) => {
      if (mode === 'validate') throw new Error('variables.set() is only available in capture scripts — use the Capture tab');
      const k = String(key);
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) throw new Error(`Invalid variable name: ${k}`);
      const s = scope === 'global' ? 'global' : scope === 'runtime' ? 'runtime' : 'suite';
      outcome.setVariables.push({ key: k, value: typeof value === 'string' ? value : JSON.stringify(value), scope: s });
    },
  });

  function makeExpect(actual: unknown) {
    const fmt = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));
    return {
      toBe: (exp: unknown) => { if (actual !== exp) throw new Error(`expected ${fmt(actual)} to be ${fmt(exp)}`); },
      toEqual: (exp: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${fmt(actual)} to equal ${fmt(exp)}`); },
      toContain: (exp: unknown) => {
        if (typeof actual === 'string' || Array.isArray(actual)) {
          if (!(actual as any).includes(exp)) throw new Error(`expected ${fmt(actual)} to contain ${fmt(exp)}`);
        } else throw new Error('toContain expects a string or array');
      },
      toMatch: (re: RegExp | string) => {
        const rx = typeof re === 'string' ? new RegExp(re) : re;
        if (!rx.test(String(actual))) throw new Error(`expected ${fmt(actual)} to match ${rx}`);
      },
      toBeLessThan: (exp: number) => { if (!(Number(actual) < exp)) throw new Error(`expected ${fmt(actual)} to be less than ${exp}`); },
      toBeGreaterThan: (exp: number) => { if (!(Number(actual) > exp)) throw new Error(`expected ${fmt(actual)} to be greater than ${exp}`); },
      toBeDefined: () => { if (actual === undefined || actual === null) throw new Error(`expected value to be defined, got ${fmt(actual)}`); },
    };
  }

  const context = vm.createContext({
    response: responseApi,
    variables: variablesApi,
    expect: makeExpect,
    test: (name: unknown, fn: unknown) => {
      const testName = String(name);
      if (typeof fn !== 'function') {
        outcome.tests.push({ name: testName, passed: false, message: 'test() requires a function as second argument' });
        outcome.failed = true;
        return;
      }
      try {
        (fn as () => void)();
        outcome.tests.push({ name: testName, passed: true });
      } catch (e: any) {
        outcome.tests.push({ name: testName, passed: false, message: e?.message || String(e) });
        outcome.failed = true;
      }
    },
    fail: (message: unknown) => {
      throw new Error(message ? String(message) : 'fail() called');
    },
    console: Object.freeze({
      log: (...args: unknown[]) => {
        outcome.logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      },
    }),
    JSON,
    Math,
  });

  try {
    vm.runInContext(code, context, { timeout: TIMEOUT_MS, displayErrors: true });
  } catch (e: any) {
    outcome.failed = true;
    outcome.error = e?.message || String(e);
  }
  return outcome;
}
