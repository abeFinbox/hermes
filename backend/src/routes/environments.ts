import { Router } from 'express';
import { db } from '../db.js';
import { newId, type Environment, type EnvironmentVariable } from '../types.js';

/**
 * Environments — named, reusable variable sets (dev, staging, custom...).
 *
 * The scope sits above the globals, and both outrank the suite's own variables:
 *   runtime > environment > global > suite
 *
 * A run picks ONE environment (the suite's default, overridable at launch) and
 * records which one it used. Nothing here is "active" globally: two suites can
 * run against different environments at the same time, which is the whole point
 * of the per-run override.
 */
export const environmentsRouter = Router();

export const VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function rowToEnv(row: any, variables: EnvironmentVariable[]): Environment {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    variables,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getEnvVars(envId: string): EnvironmentVariable[] {
  const rows = db
    .prepare('SELECT key, value, secret FROM environment_variables WHERE env_id = ? ORDER BY key')
    .all(envId) as Array<{ key: string; value: string; secret: number }>;
  return rows.map((r) => ({ key: r.key, value: r.value, secret: !!r.secret }));
}

export function getEnvironment(id: string): Environment | null {
  const row = db.prepare('SELECT * FROM environments WHERE id = ?').get(id) as any;
  return row ? rowToEnv(row, getEnvVars(id)) : null;
}

/** Name for a run record — '' when the id is unknown or nothing was selected. */
export function envNameFor(id: string | null | undefined): string {
  if (!id) return '';
  const row = db.prepare('SELECT name FROM environments WHERE id = ?').get(id) as { name: string } | undefined;
  return row?.name ?? '';
}

export function listEnvironments(): Environment[] {
  const rows = db.prepare('SELECT * FROM environments ORDER BY name').all() as any[];
  return rows.map((r) => rowToEnv(r, getEnvVars(r.id)));
}

function replaceVars(envId: string, list: EnvironmentVariable[]) {
  db.prepare('DELETE FROM environment_variables WHERE env_id = ?').run(envId);
  const stmt = db.prepare('INSERT INTO environment_variables (env_id, key, value, secret) VALUES (?, ?, ?, ?)');
  for (const v of list) stmt.run(envId, v.key, String(v.value ?? ''), v.secret ? 1 : 0);
}

/** Shared validation for a posted variable array. Returns an error message or null. */
function validateVars(list: unknown): { ok: false; error: string } | { ok: true; list: EnvironmentVariable[] } {
  if (list === undefined) return { ok: true, list: [] };
  if (!Array.isArray(list)) return { ok: false, error: 'variables must be an array' };
  const seen = new Set<string>();
  const out: EnvironmentVariable[] = [];
  for (const v of list) {
    const key = String(v?.key ?? '');
    if (!VAR_KEY_RE.test(key)) {
      return { ok: false, error: `Invalid variable name: "${key || '(empty)'}" — start with a letter/underscore, then letters, digits, _ . -` };
    }
    if (seen.has(key)) return { ok: false, error: `Duplicate variable name: ${key}` };
    seen.add(key);
    out.push({ key, value: String(v?.value ?? ''), secret: !!v?.secret });
  }
  return { ok: true, list: out };
}

environmentsRouter.get('/', (_req, res) => {
  res.json(listEnvironments());
});

environmentsRouter.get('/:id', (req, res) => {
  const env = getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  res.json(env);
});

// Create: { name, description?, variables? }
environmentsRouter.post('/', (req, res) => {
  const { name, description, variables } = req.body || {};
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Environment name is required' });
  const vars = validateVars(variables);
  if (!vars.ok) return res.status(400).json({ error: vars.error });
  if (db.prepare('SELECT 1 FROM environments WHERE name = ?').get(trimmed)) {
    return res.status(409).json({ error: `An environment named "${trimmed}" already exists` });
  }
  const id = newId();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO environments (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    trimmed,
    String(description ?? ''),
    now,
    now,
  );
  replaceVars(id, vars.list);
  res.status(201).json(getEnvironment(id));
});

// Full save: { name?, description?, variables? } — variables replace wholesale.
environmentsRouter.put('/:id', (req, res) => {
  const existing = getEnvironment(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Environment not found' });
  const { name, description, variables } = req.body || {};
  let nextName = existing.name;
  if (name !== undefined) {
    nextName = String(name).trim();
    if (!nextName) return res.status(400).json({ error: 'Environment name cannot be empty' });
    const clash = db.prepare('SELECT id FROM environments WHERE name = ? AND id != ?').get(nextName, req.params.id) as
      | { id: string }
      | undefined;
    if (clash) return res.status(409).json({ error: `An environment named "${nextName}" already exists` });
  }
  const vars = validateVars(variables);
  if (!vars.ok) return res.status(400).json({ error: vars.error });

  db.prepare('UPDATE environments SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(
    nextName,
    description !== undefined ? String(description) : existing.description,
    new Date().toISOString(),
    req.params.id,
  );
  if (variables !== undefined) replaceVars(req.params.id, vars.list);
  res.json(getEnvironment(req.params.id));
});

environmentsRouter.post('/:id/duplicate', (req, res) => {
  const src = getEnvironment(req.params.id);
  if (!src) return res.status(404).json({ error: 'Environment not found' });
  // First free "<name> (copy)", "<name> (copy 2)", ... — the name is UNIQUE.
  let name = `${src.name} (copy)`;
  for (let i = 2; db.prepare('SELECT 1 FROM environments WHERE name = ?').get(name); i++) {
    name = `${src.name} (copy ${i})`;
  }
  const id = newId();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO environments (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    name,
    src.description,
    now,
    now,
  );
  replaceVars(id, src.variables);
  res.status(201).json(getEnvironment(id));
});

// Deleting an environment clears it from any suite pointing at it, so those
// suites fall back to globals + suite variables instead of a dangling id.
// Existing run rows keep env_name, which is why it is stored alongside env_id.
environmentsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM environment_variables WHERE env_id = ?').run(req.params.id);
  db.prepare('DELETE FROM environments WHERE id = ?').run(req.params.id);
  db.prepare('UPDATE suites SET default_env_id = NULL WHERE default_env_id = ?').run(req.params.id);
  res.json({ ok: true });
});
