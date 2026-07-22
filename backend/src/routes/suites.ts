import { Router } from 'express';
import { db } from '../db.js';
import { newId, defaultSettings, emptyStep, type Suite } from '../types.js';
import { exportSuiteAsCollection } from '../postman-export.js';

export const suitesRouter = Router();

function rowToSuite(row: any): Suite {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    collectionId: row.collection_id,
    steps: JSON.parse(row.steps_json),
    variables: JSON.parse(row.variables_json),
    settings: { ...defaultSettings(), ...JSON.parse(row.settings_json) },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getSuite(id: string): Suite | null {
  const row = db.prepare('SELECT * FROM suites WHERE id = ?').get(id) as any;
  return row ? rowToSuite(row) : null;
}

suitesRouter.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM suites ORDER BY updated_at DESC').all() as any[];
  res.json(
    rows.map((r) => {
      const s = rowToSuite(r);
      return {
        id: s.id, name: s.name, description: s.description, collectionId: s.collectionId,
        stepCount: s.steps.length, createdAt: s.createdAt, updatedAt: s.updatedAt,
      };
    }),
  );
});

suitesRouter.get('/:id', (req, res) => {
  const suite = getSuite(req.params.id);
  if (!suite) return res.status(404).json({ error: 'Suite not found' });
  res.json(suite);
});

// Create a suite from scratch: { name, description? }
suitesRouter.post('/', (req, res) => {
  const { name, description } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Suite name is required' });
  const id = newId();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO suites (id, name, description, collection_id, steps_json, variables_json, settings_json, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)',
  ).run(id, String(name).trim(), String(description || ''), JSON.stringify([emptyStep()]), '[]', JSON.stringify(defaultSettings()), now, now);
  res.status(201).json(getSuite(id));
});

// Full save of a suite (meta + steps + variables + settings)
suitesRouter.put('/:id', (req, res) => {
  const existing = getSuite(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Suite not found' });
  const { name, description, steps, variables, settings } = req.body || {};
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'Suite name cannot be empty' });
  if (steps !== undefined && !Array.isArray(steps)) return res.status(400).json({ error: 'steps must be an array' });
  if (variables !== undefined && !Array.isArray(variables)) return res.status(400).json({ error: 'variables must be an array' });

  db.prepare('UPDATE suites SET name = ?, description = ?, steps_json = ?, variables_json = ?, settings_json = ?, updated_at = ? WHERE id = ?').run(
    name !== undefined ? String(name).trim() : existing.name,
    description !== undefined ? String(description) : existing.description,
    JSON.stringify(steps !== undefined ? steps : existing.steps),
    JSON.stringify(variables !== undefined ? variables : existing.variables),
    JSON.stringify(settings !== undefined ? { ...existing.settings, ...settings } : existing.settings),
    new Date().toISOString(),
    req.params.id,
  );
  res.json(getSuite(req.params.id));
});

// Export a suite as a Postman collection v2.1 (re-importable here or in Postman)
suitesRouter.get('/:id/export', (req, res) => {
  const suite = getSuite(req.params.id);
  if (!suite) return res.status(404).json({ error: 'Suite not found' });
  const collection = exportSuiteAsCollection(suite);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${suite.name.replace(/[^\w.-]+/g, '-')}.postman_collection.json"`,
  );
  res.json(collection);
});

suitesRouter.post('/:id/duplicate', (req, res) => {
  const suite = getSuite(req.params.id);
  if (!suite) return res.status(404).json({ error: 'Suite not found' });
  const id = newId();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO suites (id, name, description, collection_id, steps_json, variables_json, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, `${suite.name} (copy)`, suite.description, suite.collectionId, JSON.stringify(suite.steps), JSON.stringify(suite.variables), JSON.stringify(suite.settings), now, now);
  res.status(201).json(getSuite(id));
});

suitesRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM suites WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
