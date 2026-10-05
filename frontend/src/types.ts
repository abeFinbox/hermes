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
  body: { mode: BodyMode; content: string; formData?: FormDataField[]; sendWithGet?: boolean };
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

export interface StepPolling {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
  stopScript: string;
}

export interface Step {
  id: string;
  name: string;
  enabled: boolean;
  folderPath: string;
  request: StepRequest;
  validations: { visual: Assertion[]; script: string };
  captures: { visual: CaptureRule[]; script: string };
  polling?: StepPolling;
  postmanEvents?: unknown[];
  sourceRequest?: StepRequest;
}

export function defaultPolling(): StepPolling {
  return { enabled: false, intervalMs: 2000, timeoutMs: 30000, stopScript: '' };
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
  /** Environment pre-selected for runs of this suite; null = none. */
  defaultEnvId: string | null;
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

// Result of POST /api/suites/import-bundle — a native bundle import.
export interface BundleImportResult {
  suiteId: string;
  name: string;
  stepCount: number;
  fileMap: Record<string, string>;
  importedGlobals: string[];
  skippedGlobals: string[];
  secretsNeeded: string[];
  warnings: string[];
}

// ---- Hera (k6 load testing) ----
// Mirrors backend/src/hera/{summary,progress,runner}.ts and the Go equivalents.

/**
 * `interrupted` is set by the boot-time reaper when a run's owning process died
 * without finishing — it is a real terminal state, not a UI-only one.
 */
export type HeraStatus =
  | 'queued'
  | 'ramping'
  | 'running'
  | 'stopping'
  | 'passed'
  | 'failed'
  | 'error'
  | 'stopped'
  | 'interrupted';

const HERA_ACTIVE: ReadonlySet<string> = new Set(['queued', 'ramping', 'running', 'stopping']);

/** Both the poll loop and the Stop button key off this, so it lives in one place. */
export function isHeraActive(s: HeraStatus | string | undefined): boolean {
  return HERA_ACTIVE.has(String(s));
}

export interface HeraTrend {
  min: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

/** What the launch form sends. */
export interface HeraRequestedConfig {
  suiteId: string;
  vus: number;
  durationSec: number;
  thinkTimeMs?: number;
  p95Ms?: number | null;
  errorRatePct?: number | null;
}

/** What the server actually ran, after clamping. `rps` is server-chosen. */
export interface HeraAppliedConfig {
  suiteId: string;
  vus: number;
  durationSec: number;
  rps: number;
  /** Shape of the run. Absent on runs recorded before profiles existed. */
  mode?: string;
  /** Target requests/s, set only by 'rate' mode. */
  ratePerSec?: number | null;
  thinkTimeMs: number;
  p95Ms: number | null;
  errorRatePct: number | null;
}

/**
 * One progress sample. NOTE the mixed time bases, which the charts must label:
 * rps/errorRatePct/vus are instantaneous, but the latency percentiles are
 * CUMULATIVE over the run so far — k6's REST API cannot de-cumulate a trend.
 * p99 is absent live and only appears in the final summary.
 */
export interface HeraSample {
  t: number;
  vus: number;
  rps: number;
  errorRatePct: number;
  p50: number;
  p90: number;
  p95: number;
}

export interface HeraStepStats {
  stepId: string;
  name: string;
  method: string;
  url: string;
  requests: number;
  errorRate: number;
  latency: HeraTrend | null;
  pollAttempts: HeraTrend | null;
  pollWaitMs: HeraTrend | null;
  scriptErrors: number;
}

export interface HeraSummary {
  requests: number;
  errorRate: number;
  rps: number;
  iterations: number;
  iterationDuration: HeraTrend | null;
  latency: HeraTrend | null;
  checksPassed: number;
  checksTotal: number;
  scriptErrors: number;
  suppressedGlobalWrites: number;
  dataSent: number;
  dataReceived: number;
  droppedIterations: number;
  vusMax: number;
}

export interface HeraRunListItem {
  id: string;
  suiteId: string;
  suiteName: string;
  status: HeraStatus;
  /** Environment the load test ran against (null = globals + suite only). */
  envId: string | null;
  envName: string;
  config: HeraAppliedConfig;
  startedAt: string;
  finishedAt: string | null;
  summary: HeraSummary | null;
  confidence: string;
  k6Version: string;
  backend: string;
  exitCode: number | null;
}

export interface HeraRun extends HeraRunListItem {
  requestedConfig: { applied?: HeraAppliedConfig; clampNotes?: string[] } & Partial<HeraAppliedConfig>;
  targetHosts: string[];
  steps: HeraStepStats[];
  samples: HeraSample[];
  /** Total held server-side, so `?since=` responses can still show progress. */
  sampleCount: number;
  stderrTail: string;
}

/** One stage of a shaped run: reach `target` VUs by the end of it. */
export interface HeraStage {
  durationSec: number;
  target: number;
}

/**
 * The derived shape of a run. Always fetched from the server — deriving stages
 * in the browser would be a third implementation nobody diffs.
 */
export interface HeraProfilePreview {
  modes: Array<{ mode: string; label: string }>;
  /** Server ceiling for requests/s, which 'rate' mode is clamped to. */
  maxRps: number;
  mode: string;
  vus: number;
  durationSec: number;
  /** Empty for the flat modes, which use plain vus + duration. */
  stages: HeraStage[];
  /** Set only for 'rate', which pins throughput instead of VUs. */
  ratePerSec: number | null;
  summary: string;
  /** Why the requested shape was not used verbatim, if it was not. */
  notes: string[];
}

/** One line of k6 output. level is 'raw' when the line was not JSON. */
export interface HeraLogLine {
  n: number;
  t: string;
  level: string;
  msg: string;
}

export interface HeraLogsResponse {
  lines: HeraLogLine[];
  /** Total lines ever emitted; pass back as ?sinceLine= to resume. */
  cursor: number;
  /** Oldest retained line number; 0 when nothing is retained. */
  firstLine: number;
  /** Lines evicted from the server-side ring. */
  dropped: number;
  runBackend: string;
  live: boolean;
  available: boolean;
  /**
   * How to merge: 'live' numbering is monotonic, so append and resume from
   * `cursor`. 'tail' comes from the persisted 64KB suffix and renumbers from 1,
   * so REPLACE the buffer instead — appending shows every line twice the moment
   * a run finishes. 'none' means this engine has nothing; keep what you have.
   */
  source: 'live' | 'tail' | 'none';
  reason?: string;
}

/**
 * A paste-runnable cURL for one step. Built on demand and never persisted — it
 * resolves real values, secret variables included, so it is only served to the
 * roles that may launch a run.
 */
export interface HeraStepCurl {
  stepId: string;
  name: string;
  method: string;
  curl: string;
  /** Variables captured at runtime, left as {{name}} for the reader to fill. */
  unresolved: string[];
  /** The suite changed after the run, so this is the request as it is NOW. */
  staleWarning: boolean;
}

export interface HeraCapability {
  available: boolean;
  enabled: boolean;
  version: string | null;
  platform: string | null;
  reason?: string;
  maxVus: number;
  maxDurationSec: number;
  maxRps: number;
  maxRequests: number;
  allowModerator: boolean;
  /** No HERA_TARGET_ALLOW set — only this instance's own /mock is reachable. */
  selfMockOnly: boolean;
  canLaunch: boolean;
}

export interface HeraResolvedTarget {
  ok: boolean;
  reason?: string;
  host?: string;
  port?: string;
  scheme?: string;
  resolvedIp?: string;
  allIps?: string[];
  selfMock?: boolean;
}

export interface HeraPreflightStep {
  stepId: string;
  name: string;
  method: string;
  url: string;
  resolvedUrl: string;
  unresolvedTokens: string[];
  target: HeraResolvedTarget;
}

export interface HeraPreflight {
  ok: boolean;
  steps: HeraPreflightStep[];
  hosts: Array<{ origin: string; requests: number; external: boolean }>;
  findings: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
  estimate: { requestsPerIteration: number; unbounded: boolean; note: string };
  secretsNeeded: string[];
  /** Environment this preview resolved against, echoed back by the server. */
  envId?: string | null;
  envName?: string;
}

/** Small enough to be harmless, large enough to be useful. */
export function defaultHeraConfig(suiteId: string): HeraRequestedConfig {
  return { suiteId, vus: 5, durationSec: 30, thinkTimeMs: 0, p95Ms: null, errorRatePct: null };
}

export interface GlobalVariable {
  key: string;
  value: string;
  secret: boolean;
}

/** One variable inside an environment — same shape as a global/suite variable. */
export interface EnvironmentVariable {
  key: string;
  value: string;
  secret: boolean;
}

/**
 * A named, reusable variable set (dev, staging, custom...). The most specific
 * layer below runtime captures: runtime > environment > global > suite.
 */
export interface Environment {
  id: string;
  name: string;
  description: string;
  variables: EnvironmentVariable[];
  createdAt: string;
  updatedAt: string;
}

/** Result of POST /api/runs/try-script — the script bench in the step editor. */
export interface ScriptBenchResult {
  mode: 'validate' | 'capture' | 'poll';
  assertions: AssertionResult[];
  captured: CapturedValue[];
  logs: string[];
  /** True when a poll stop script called stop() — polling would end here. */
  stopRequested: boolean;
  failed: boolean;
  /** Script threw outside a test(): syntax error, bad JSON.parse, timeout. */
  error?: string;
  usedVariables: Array<{ key: string; value: string }>;
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

export interface PollAttempt {
  attempt: number;
  status: number;
  statusText: string;
  timeMs: number;
  body: string;
  bodyTruncated: boolean;
  stopped: boolean;
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
  pollAttempts?: PollAttempt[];
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
  /** Environment this run resolved variables against (null = globals + suite). */
  envId: string | null;
  /** Name at launch time — readable even after a rename or delete. */
  envName: string;
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
