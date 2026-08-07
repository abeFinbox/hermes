import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * Legends: an app-wide toggle that reveals ⓘ badges next to every function.
 * Hovering a badge explains what the control does. All explanation copy
 * lives in the LEGENDS map below so it is easy to maintain and translate.
 */

export const LEGENDS: Record<string, string> = {
  'app.name': 'The Messenger — Hermes carries your API requests, delivers their responses, and reports back. Import Postman collections, chain requests into test suites, validate and run them.',
  'nav.collections': 'Imported Postman collections. Import a .json export here; a test suite is generated automatically.',
  'nav.suites': 'Test suites — ordered lists of API requests with validations and variable chaining. Create from a collection or from scratch.',
  'nav.variables': 'Global variables, shared by every suite. Referenced anywhere with {{variableName}}.',
  'nav.files': 'A shared store for files you attach to requests. Upload here, then reference a file from any request’s form-data body. Files live on the server, not inside suites.',
  'nav.runs': 'History of suite executions with per-step results and the report generator.',
  'nav.settings': 'Change your password; admins can manage users.',
  'nav.docs': 'Read the built-in documentation — README, User Manual and Deployment guide — rendered right here, and downloadable.',
  'step.search': 'Filter the steps by name, method, URL or folder. Only matching steps are shown; the full list returns when you clear the box. Filtering never changes the suite or the run order.',
  'topbar.metrics': 'Live resource usage of the Hermes backend (the process that executes your suites): CPU as % of one core and memory (RSS), sampled every 2 s over a ~2 minute window. Hover a graph for exact numbers. Dims if the backend is unreachable.',
  'nav.appearance': 'Pick a theme — System (follows your OS), light/dark presets, or build your own with full color control.',
  'appearance.mode': 'System switches between Light and Dark automatically with your OS preference. Any other choice is fixed.',
  'appearance.custom': 'Your own themes. Start from any preset via “customize”. Stored in this browser (export JSON to move or share them).',
  'appearance.builder': 'Every color token previews live as you change it. Cancel reverts the preview; Save persists the theme and applies it.',
  'appearance.import': 'Load a theme JSON file that was exported from this app (from any browser or teammate).',
  'collections.import': 'Paste or upload a Postman collection v2.0/v2.1 JSON export. Folders and requests are converted into an editable suite.',
  'collections.createSuite': 'Also generate a ready-to-edit test suite from this collection (recommended).',
  'suites.new': 'Create an empty suite from scratch — add requests manually, no Postman import needed.',
  'suites.export': 'Download this suite as a Postman collection v2.1 JSON — openable in Postman or re-importable here. Folders, requests, auth and variables are included; original pm scripts are kept, visual assertions/captures become pm test scripts, and secret variable values are masked.',
  'nav.hera': 'Hera — load testing. Runs an existing suite under concurrency with k6: every virtual user walks all enabled steps in order, carrying captures between them, then loops.',
  'hera.launch': 'Pick a suite, choose how many virtual users and for how long, then start. Each virtual user repeats the whole suite, so one iteration is roughly one request per enabled step.',
  'hera.vus': 'Virtual users run concurrently, each walking every enabled step of the suite in order, then looping. 10 VUs on a 6-step suite means up to 10 requests in flight and 60 requests per full pass.',
  'hera.duration': 'How long to keep generating load. Virtual users finish the iteration they are in, so a run can overrun slightly.',
  'hera.thresholds': 'Thresholds decide the final verdict. With none set, a test that finishes is reported passed even if every request was slow — only a k6 failure or a broken script marks it failed.',
  'hera.targets': 'The origins this suite will actually hit, resolved from your variables. Hosts are pinned to a resolved IP before the run, so a DNS change mid-run cannot redirect the load somewhere else.',
  'hera.caps': 'Server-side limits. Requests above them are reduced, not rejected — the run reports what it actually used.',
  'hera.unavailable': 'Hera shells out to the real k6 binary on the host running this backend. Each engine probes its own host, so switching engine may help.',
  'hera.stop': 'Asks k6 to stop. In-flight virtual users drain first, so the run reports "stopping" briefly before it settles.',
  'hera.latencyChart': 'Response-time percentiles. These are CUMULATIVE over the run so far — k6 reports a running trend that cannot be de-cumulated, so a late spike is diluted rather than sharp. p99 appears only in the final summary.',
  'hera.throughputChart': 'Requests per second and errors per second, both instantaneous — measured from the change between samples rather than a running average.',
  'hera.vuChart': 'Virtual users actually active. If this sits below what you asked for, k6 could not keep up and the numbers understate the load.',
  'hera.stepTable': 'Per-step breakdown. Latency here is per request, so a step that polls shows its poll requests too.',
  'hera.poll': 'For steps that poll: how many attempts a completion took, and how long the caller waited. The p95 wait is the useful number for an async pipeline — it is time-to-completion under concurrency, not per-request latency.',
  'hera.confidence': 'Low confidence means this host was too CPU-starved for the latency figures to be trusted — k6 timestamps in userspace, so its own scheduling stalls get attributed to your target.',
  'suite.loadTest': 'Load-test this suite with Hera — same steps, same captures, but run concurrently by many virtual users.',
  'suites.bundle':'Download this suite as a Hermes bundle — a lossless snapshot for moving it to another Hermes instance (local → Docker → prod). Unlike the Postman export it keeps polling config, suite settings, sandbox scripts, visual assertions and the attached file bytes. Not openable in Postman.',
  'suites.importBundle': 'Load a .hermes-bundle.json exported from another Hermes instance. A new suite is created (never overwriting an existing one), attached files are re-uploaded here and referenced by their new ids.',
  'suites.bundleSecrets': 'Off by default: secret values are masked and listed so you can refill them on the target. Turning this on writes them in plaintext into a file on your disk — treat that file as a credential.',
  'suites.bundleGlobals': 'Global variables the suite references travel with it. Existing values on this instance are kept unless you allow overwriting.',
  'suite.run': 'Execute all enabled steps in order. Cycles > 1 repeats the whole suite; captured suite variables reset each cycle, globals persist.',
  'suite.cycles': 'How many times to repeat the whole suite in this run (1–100). Used by the report to aggregate results.',
  'suite.stopOnFailure': 'If a step fails, skip the remaining steps of that cycle instead of continuing.',
  'suite.save': 'Persist every edit in this editor (steps, variables, settings). Nothing is saved until you click Save.',
  'suite.variables': 'Suite-scoped variables. They override globals with the same name, and captures write back here between steps.',
  'suite.settings': 'Runner behaviour for this suite: timeouts, default cycles, failure handling.',
  'step.enabled': 'Disabled steps are skipped by the runner but stay in the suite.',
  'suite.composer': 'Collect requests into a floating basket and turn them into a brand-new suite. While on, every step row gets a ＋ button and rows become draggable — drop them on the basket. The basket keeps its contents while you move between suites, so you can mix requests from several suites.',
  'composer.box': 'Drag this header to move the box. Reorder with ↑/↓ — the order here becomes the step order of the new suite. Steps are copied (with their validations and captures); the original suites are not touched.',
  'step.send': 'Run just this request now — with your current (unsaved) edits and all global + suite variables. Its response, assertions and captures appear below; suite-scope captures are folded into the suite variables so you can Send the next step and test the chain one request at a time. Nothing is saved.',
  'step.reorder': 'Execution order matters: captures from earlier steps feed {{variables}} in later ones. Use ↑/↓ to reorder.',
  'step.reset': 'Restore this request to exactly what was imported from Postman, discarding your edits.',
  'step.request': 'The HTTP request. Every field supports {{variable}} placeholders, resolved at run time.',
  'body.formdata': 'form-data sends a multipart/form-data body — mix text fields and file uploads. File fields reference a file from the Files store (upload it there first). Content-Type is set automatically with the multipart boundary.',
  'files.store': 'Files uploaded here are stored on the server (DATA_DIR/files) and can be attached to any request’s form-data body. Deleting a file leaves referencing requests needing a new attachment.',
  'step.validate': 'Checks that run after the response arrives. Visual rules for common cases; the script mode gives you test() + expect() for anything else.',
  'step.capture': 'Pull values out of this response into variables for later steps — this is how you chain APIs. Visual rules or a script with variables.set().',
  'step.captureScope': 'suite: value lives for this run and is saved to suite variables. global: persisted immediately for all suites.',
  'validate.script': 'JavaScript run in a sandbox after the response. API: test(name, fn), expect(value).toBe/.toEqual/.toContain/.toMatch/.toBeLessThan/.toBeGreaterThan/.toBeDefined, response.status/.json()/.text()/.headers/.time, variables.get(). Each test() becomes a line in the report.',
  'capture.script': 'JavaScript run in a sandbox after the response. Use variables.set("name", value) or variables.set("name", value, "global"). Also available: response.json()/.text()/.headers/.status, console.log() (shown in run logs), fail(msg).',
  'variables.secret': 'Secret values are masked in the UI. (v1: they are still stored in plain text in the database.)',
  'variables.promote': 'This {{placeholder}} is not defined anywhere. Click to define it as a global variable now.',
  'runs.stop': 'Stop this in-progress run. The current request is aborted, remaining steps are marked skipped, and the run ends with status “stopped”. Only works while the run is executing on this server.',
  'step.curl': 'A ready-to-run cURL command reproducing exactly what this request sent — resolved URL, headers, and body. Real values (including secrets) are included so it works when pasted into a terminal. Shown for single-step Send and for each step in a saved run; note the saved-run copy is persisted in the local runs database.',
  'runs.report': 'Generate a structured report for this run. Currently a stub that returns JSON — the extension point for HTML/PDF reports.',
  'runs.cycles': 'Each cycle is a full pass over the suite. Expand a cycle to see per-step results, assertions, captured variables and script logs.',
  'login.captcha': 'Generated locally on the server (svg-captcha) — no external service. Click the image for a new one.',
};

interface LegendsCtx {
  on: boolean;
  toggle: () => void;
}

const Ctx = createContext<LegendsCtx>({ on: false, toggle: () => {} });

export function LegendsProvider({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(() => localStorage.getItem('ats.legends') === '1');
  const toggle = () => {
    setOn((v) => {
      localStorage.setItem('ats.legends', v ? '0' : '1');
      return !v;
    });
  };
  return <Ctx.Provider value={{ on, toggle }}>{children}</Ctx.Provider>;
}

export function useLegends() {
  return useContext(Ctx);
}

/** ⓘ badge with hover tooltip; rendered only while Legends is toggled on. */
export function Info({ k }: { k: keyof typeof LEGENDS }) {
  const { on } = useLegends();
  if (!on) return null;
  return (
    <span className="info-badge" data-tip={LEGENDS[k] || k} tabIndex={0}>
      i
    </span>
  );
}
