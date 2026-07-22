// Mirrors backend/src/types.ts

export interface KV {
  key: string;
  value: string;
  enabled: boolean;
}

export type BodyMode = 'none' | 'raw' | 'json' | 'form' | 'form-data';

export interface FormDataField {
  id: string;
  key: string;
  type: 'text' | 'file';
  value: string;
  fileId: string;
  enabled: boolean;
}

export interface StoredFile {
  id: string;
  originalName: string;
  size: number;
  mime: string;
  createdAt: string;
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
  expression?: string;
  expected?: string;
}

export type CaptureSource = 'body-jsonpath' | 'header' | 'status' | 'body-text';

export interface CaptureRule {
  id: string;
  source: CaptureSource;
  expression: string;
  targetVariable: string;
  scope: 'suite' | 'global';
}

export interface Step {
  id: string;
  name: string;
  enabled: boolean;
  folderPath: string;
  request: StepRequest;
  validations: { visual: Assertion[]; script: string };
  captures: { visual: CaptureRule[]; script: string };
  postmanEvents?: unknown[];
  sourceRequest?: StepRequest;
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

export interface SuiteListItem {
  id: string;
  name: string;
  description: string;
  collectionId: string | null;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GlobalVariable {
  key: string;
  value: string;
  secret: boolean;
}

export interface CollectionListItem {
  id: string;
  name: string;
  createdAt: string;
}

export interface TreeNode {
  type: 'folder' | 'request';
  name: string;
  method?: string;
  url?: string;
  stepId?: string;
  children?: TreeNode[];
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
  curl?: string;
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

export type Role = 'admin' | 'moderator' | 'npc';

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  role: Role;
  captchaExempt?: boolean;
  createdAt?: string;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function emptyStep(name = 'New request'): Step {
  return {
    id: newId(),
    name,
    enabled: true,
    folderPath: '',
    request: {
      method: 'GET',
      url: '',
      headers: [],
      params: [],
      body: { mode: 'none', content: '' },
      auth: { type: 'none' },
    },
    validations: { visual: [], script: '' },
    captures: { visual: [], script: '' },
  };
}
