import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, FILES_DIR } from './db.js';
import { getFileRow } from './routes/files.js';
import { getGlobals, setGlobal } from './routes/variables.js';
import { defaultSettings, newId, type FormDataField, type GlobalVariable, type Step, type Suite, type SuiteVariable } from './types.js';

/**
 * Native suite bundle — the lossless counterpart to postman-export.ts.
 *
 * A Postman collection has nowhere to put polling config, suite settings,
 * sandbox scripts or visual assertions, so exporting a suite that way and
 * re-importing it elsewhere silently degrades it. A bundle instead carries the
 * Suite shape verbatim plus the attached file blobs, so an import on another
 * instance (local -> docker, docker -> prod) reproduces the suite exactly.
 */

export const BUNDLE_VERSION = 1;

// base64 inflates ~33%; warn past this so nobody generates a JSON the browser
// cannot hold. Export still proceeds — it is a warning, not a limit.
export const FILE_BYTES_WARN = 20 * 1024 * 1024;

export const SECRET_PLACEHOLDER = '';

export interface BundleFile {
  id: string; // id in the SOURCE instance — remapped on import
  originalName: string;
  mime: string;
  size: number;
  sha256: string;
  contentBase64: string;
}

export interface HermesBundle {
  hermesBundle: number;
  exportedAt: string;
  suite: {
    name: string;
    description: string;
    steps: Step[];
    variables: SuiteVariable[];
    settings: Suite['settings'];
  };
  globals: GlobalVariable[];
  files: BundleFile[];
  // keys whose values were masked — the importer surfaces these to be filled in
  secretsNeeded: string[];
}

/** Every {{token}} referenced anywhere in the suite (urls, headers, bodies, scripts). */
function referencedVarKeys(suite: Suite): Set<string> {
  const keys = new Set<string>();
  const haystack = JSON.stringify({ steps: suite.steps, variables: suite.variables });
  for (const m of haystack.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g)) keys.add(m[1]);
  return keys;
}

/** Every stored-file id referenced by a form-data part, with where it came from. */
function referencedFileIds(steps: Step[]): Array<{ fileId: string; stepName: string; key: string }> {
  const out: Array<{ fileId: string; stepName: string; key: string }> = [];
  for (const step of steps) {
    for (const f of step.request.body.formData || []) {
      if (f.type === 'file' && f.fileId) out.push({ fileId: f.fileId, stepName: step.name, key: f.key });
    }
  }
  return out;
}

export interface BuildBundleOptions {
  includeFiles?: boolean;
  includeSecrets?: boolean;
}

export function buildBundle(suite: Suite, opts: BuildBundleOptions = {}): { bundle: HermesBundle; warnings: string[] } {
  const includeFiles = opts.includeFiles !== false;
  const includeSecrets = opts.includeSecrets === true;
  const warnings: string[] = [];
  const secretsNeeded: string[] = [];

  const variables: SuiteVariable[] = suite.variables.map((v) => {
    if (v.secret && !includeSecrets) {
      secretsNeeded.push(v.key);
      return { ...v, value: SECRET_PLACEHOLDER };
    }
    return { ...v };
  });

  // only the globals this suite actually uses — no dragging the whole
  // Variables page along with one suite
  const referenced = referencedVarKeys(suite);
  const suiteKeys = new Set(suite.variables.map((v) => v.key));
  const globals: GlobalVariable[] = getGlobals()
    .filter((g) => referenced.has(g.key) && !suiteKeys.has(g.key))
    .map((g) => {
      if (g.secret && !includeSecrets) {
        secretsNeeded.push(g.key);
        return { ...g, value: SECRET_PLACEHOLDER };
      }
      return { ...g };
    });

  const files: BundleFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  if (includeFiles) {
    for (const ref of referencedFileIds(suite.steps)) {
      if (seen.has(ref.fileId)) continue;
      seen.add(ref.fileId);
      const row = getFileRow(ref.fileId);
      if (!row) {
        warnings.push(`Step "${ref.stepName}": form-data part "${ref.key}" points at a file that no longer exists — the part will import with no file attached.`);
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(FILES_DIR, row.stored_name));
      } catch {
        warnings.push(`Step "${ref.stepName}": file "${row.original_name}" is missing from the file store — the part will import with no file attached.`);
        continue;
      }
      totalBytes += bytes.length;
      files.push({
        id: row.id,
        originalName: row.original_name,
        mime: row.mime,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentBase64: bytes.toString('base64'),
      });
    }
    if (totalBytes > FILE_BYTES_WARN) {
      warnings.push(
        `Embedded files total ${mb(totalBytes)} MB (base64 makes the bundle roughly ${mb(totalBytes * 1.34)} MB). Large bundles are slow to upload and may hit request size limits.`,
      );
    }
  } else {
    const skipped = new Set(referencedFileIds(suite.steps).map((r) => r.fileId));
    if (skipped.size) {
      warnings.push(`${skipped.size} attached file(s) were not embedded — re-attach them on the target instance after importing.`);
    }
  }

  if (includeSecrets && (suite.variables.some((v) => v.secret) || getGlobals().some((g) => g.secret && referenced.has(g.key)))) {
    warnings.push('This bundle contains secret values in plaintext. Treat the file as a credential.');
  }

  return {
    bundle: {
      hermesBundle: BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      suite: {
        name: suite.name,
        description: suite.description,
        steps: suite.steps,
        variables,
        settings: suite.settings,
      },
      globals,
      files,
      secretsNeeded: [...new Set(secretsNeeded)],
    },
    warnings,
  };
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

// ---- import ----

export class BundleError extends Error {}

/** Shape-check an untrusted payload before touching the database. */
export function parseBundle(raw: unknown): HermesBundle {
  const b = (typeof raw === 'string' ? safeParse(raw) : raw) as HermesBundle | null;
  if (!b || typeof b !== 'object') throw new BundleError('Not a JSON object');
  if (typeof b.hermesBundle !== 'number') {
    throw new BundleError('Missing "hermesBundle" — this looks like a Postman collection, not a Hermes bundle. Use Import collection for those.');
  }
  if (b.hermesBundle > BUNDLE_VERSION) {
    throw new BundleError(`Bundle format v${b.hermesBundle} is newer than this instance supports (v${BUNDLE_VERSION}). Upgrade Hermes on this instance.`);
  }
  if (!b.suite || typeof b.suite !== 'object') throw new BundleError('Missing "suite"');
  if (!b.suite.name || !String(b.suite.name).trim()) throw new BundleError('Suite name is empty');
  if (!Array.isArray(b.suite.steps)) throw new BundleError('"suite.steps" must be an array');
  if (b.suite.variables !== undefined && !Array.isArray(b.suite.variables)) throw new BundleError('"suite.variables" must be an array');
  if (b.globals !== undefined && !Array.isArray(b.globals)) throw new BundleError('"globals" must be an array');
  if (b.files !== undefined && !Array.isArray(b.files)) throw new BundleError('"files" must be an array');
  return b;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch (e: any) {
    throw new BundleError(`Invalid JSON: ${e.message}`);
  }
}

export interface ImportBundleOptions {
  name?: string; // override the suite name (defaults to the bundle's, deduped)
  includeGlobals?: boolean; // default true
  overwriteGlobals?: boolean; // default false — keep this instance's values
}

export interface ImportBundleResult {
  suiteId: string;
  name: string;
  stepCount: number;
  fileMap: Record<string, string>; // source file id -> id in this instance
  importedGlobals: string[];
  skippedGlobals: string[];
  secretsNeeded: string[];
  warnings: string[];
}

export function importBundle(bundle: HermesBundle, opts: ImportBundleOptions = {}): ImportBundleResult {
  const includeGlobals = opts.includeGlobals !== false;
  const overwriteGlobals = opts.overwriteGlobals === true;
  const warnings: string[] = [];

  // 1. Land the blobs first and build the id mapping.
  const fileMap: Record<string, string> = {};
  for (const f of bundle.files || []) {
    if (!f?.id || typeof f.contentBase64 !== 'string') {
      warnings.push('A file entry in the bundle was malformed and was skipped.');
      continue;
    }
    const bytes = Buffer.from(f.contentBase64, 'base64');
    if (f.sha256) {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== f.sha256) {
        warnings.push(`File "${f.originalName}" failed its checksum and was skipped — the bundle may be corrupt.`);
        continue;
      }
    }
    const id = newId();
    const storedName = `${id}${extOf(f.originalName || '')}`;
    writeFileSync(join(FILES_DIR, storedName), bytes);
    db.prepare('INSERT INTO files (id, original_name, stored_name, size, mime, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      f.originalName || 'unnamed',
      storedName,
      bytes.length,
      f.mime || '',
      new Date().toISOString(),
    );
    fileMap[f.id] = id;
  }

  // 2. Rewrite every form-data fileId to point at this instance's store.
  const steps: Step[] = JSON.parse(JSON.stringify(bundle.suite.steps || []));
  for (const step of steps) {
    const parts: FormDataField[] | undefined = step.request?.body?.formData;
    if (!parts) continue;
    for (const part of parts) {
      if (part.type !== 'file' || !part.fileId) continue;
      const mapped = fileMap[part.fileId];
      if (mapped) {
        part.fileId = mapped;
      } else {
        part.fileId = '';
        warnings.push(`Step "${step.name}": form-data part "${part.key}" had no file in the bundle — attach one before running.`);
      }
    }
  }

  // 3. Globals — never clobber this instance's values unless asked.
  const importedGlobals: string[] = [];
  const skippedGlobals: string[] = [];
  if (includeGlobals) {
    const existing = new Map(getGlobals().map((g) => [g.key, g]));
    for (const g of bundle.globals || []) {
      if (!g?.key) continue;
      if (existing.has(g.key) && !overwriteGlobals) {
        skippedGlobals.push(g.key);
        continue;
      }
      setGlobal(g.key, String(g.value ?? ''), !!g.secret);
      importedGlobals.push(g.key);
    }
  }

  // 4. The suite itself — new id, name deduped so repeat imports don't collide.
  const suiteId = newId();
  const name = uniqueName(String(opts.name || bundle.suite.name).trim());
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO suites (id, name, description, collection_id, steps_json, variables_json, settings_json, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)',
  ).run(
    suiteId,
    name,
    String(bundle.suite.description || ''),
    JSON.stringify(steps),
    JSON.stringify(bundle.suite.variables || []),
    JSON.stringify({ ...defaultSettings(), ...(bundle.suite.settings || {}) }),
    now,
    now,
  );

  const secretsNeeded = [
    ...new Set([
      ...(bundle.secretsNeeded || []),
      ...(bundle.suite.variables || []).filter((v) => v.secret && !v.value).map((v) => v.key),
    ]),
  ];
  if (secretsNeeded.length) {
    warnings.push(`Secret values were not included in the bundle: ${secretsNeeded.join(', ')}. Fill them in before running.`);
  }

  return {
    suiteId,
    name,
    stepCount: steps.length,
    fileMap,
    importedGlobals,
    skippedGlobals,
    secretsNeeded,
    warnings,
  };
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, '') : '';
}

/** "Checkout flow" -> "Checkout flow (imported)" -> "... (imported 2)" */
function uniqueName(base: string): string {
  const taken = new Set(
    (db.prepare('SELECT name FROM suites').all() as Array<{ name: string }>).map((r) => r.name),
  );
  if (!taken.has(base)) return base;
  const candidate = `${base} (imported)`;
  if (!taken.has(candidate)) return candidate;
  for (let n = 2; n < 1000; n++) {
    const next = `${base} (imported ${n})`;
    if (!taken.has(next)) return next;
  }
  return `${base} (${newId().slice(0, 8)})`;
}
