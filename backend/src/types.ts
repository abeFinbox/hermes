export interface KV {
  key: string;
  value: string;
  enabled: boolean;
}

export type BodyMode = 'none' | 'raw' | 'json' | 'form' | 'form-data';

// One part of a multipart/form-data body. `text` parts carry a value;
// `file` parts reference a file in the managed store by id.
export interface FormDataField {
  id: string;
  key: string;
  type: 'text' | 'file';
  value: string; // text value (type 'text')
  fileId: string; // stored file id (type 'file')
  enabled: boolean;
}

export interface StepRequest {
  method: string;
  url: string;
  headers: KV[];
  params: KV[];
  body: { mode: BodyMode; content: string; formData?: FormDataField[] };
  auth:
    | { type: 'none' }
    | { type: 'bearer'; token: string }
    | { type: 'basic'; username: string; password: string };
}

export type AssertionType =
  | 'status-equals'
  | 'jsonpath-exists'
  | 'jsonpath-equals'
  | 'header-equals'
  | 'body-contains'
  | 'response-time-below';

export interface Assertion {
  id: string;
  type: AssertionType;
  expression?: string; // jsonpath or header name
  expected?: string;
}

export type CaptureSource = 'body-jsonpath' | 'header' | 'status' | 'body-text';

export interface CaptureRule {
  id: string;
  source: CaptureSource;
  expression: string; // jsonpath or header name ('' for status/body-text)
  targetVariable: string;
  scope: 'suite' | 'global';
}

export interface Step {
  id: string;
  name: string;
  enabled: boolean;
  folderPath: string; // e.g. "Auth / Tokens" from the imported collection
  request: StepRequest;
  validations: { visual: Assertion[]; script: string };
  captures: { visual: CaptureRule[]; script: string };
  postmanEvents?: unknown[]; // original pm scripts, preserved but not executed
  sourceRequest?: StepRequest; // snapshot at import time, for "reset to original"
}

export interface SuiteVariable {
  key: string;
  value: string;
  secret: boolean;
}

export interface SuiteSettings {
  stopOnFailure: boolean;
  defaultCycles: number;
  runCapturesOnFailure: boolean;
  requestTimeoutMs: number;
}

export interface Suite {
  id: string;
  name: string;
  description: string;
  collectionId: string | null;
  steps: Step[];
  variables: SuiteVariable[];
  settings: SuiteSettings;
  createdAt: string;
  updatedAt: string;
}

export interface GlobalVariable {
  key: string;
  value: string;
  secret: boolean;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  message?: string;
}

export interface CapturedValue {
  key: string;
  value: string;
  scope: 'suite' | 'global' | 'runtime';
}

export interface StepResult {
  stepId: string;
  name: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  request?: { method: string; url: string; headers: Record<string, string>; body?: string };
  response?: { status: number; statusText: string; headers: Record<string, string>; timeMs: number; body: string; bodyTruncated: boolean };
  assertions: AssertionResult[];
  captured: CapturedValue[];
  logs: string[];
  error?: string;
  curl?: string; // reproducible cURL of the actual request — only set for single-step "Send" (never persisted)
}

export interface CycleResult {
  cycle: number;
  passed: boolean;
  steps: StepResult[];
}

export interface RunSummary {
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  erroredSteps: number;
  skippedSteps: number;
  totalAssertions: number;
  passedAssertions: number;
  durationMs: number;
}

export interface Run {
  id: string;
  suiteId: string;
  suiteName: string;
  status: 'running' | 'passed' | 'failed' | 'error' | 'stopped';
  cycles: number;
  stopOnFailure: boolean;
  startedAt: string;
  finishedAt: string | null;
  cycleResults: CycleResult[];
  summary: RunSummary | null;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function defaultSettings(): SuiteSettings {
  return { stopOnFailure: false, defaultCycles: 1, runCapturesOnFailure: true, requestTimeoutMs: 30000 };
}

export function emptyRequest(): StepRequest {
  return {
    method: 'GET',
    url: '',
    headers: [],
    params: [],
    body: { mode: 'none', content: '' },
    auth: { type: 'none' },
  };
}

export function emptyStep(name = 'New request'): Step {
  return {
    id: newId(),
    name,
    enabled: true,
    folderPath: '',
    request: emptyRequest(),
    validations: { visual: [], script: '' },
    captures: { visual: [], script: '' },
  };
}
