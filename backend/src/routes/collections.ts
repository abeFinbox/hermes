import { Router } from 'express';
import { db } from '../db.js';
import { importCollection } from '../postman.js';
import { newId, defaultSettings } from '../types.js';

export const collectionsRouter = Router();

collectionsRouter.get('/', (_req, res) => {
  const rows = db.prepare('SELECT id, name, created_at FROM collections ORDER BY created_at DESC').all() as Array<{
    id: string; name: string; created_at: string;
  }>;
  res.json(rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at })));
});

collectionsRouter.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'Collection not found' });
  res.json({ id: row.id, name: row.name, tree: JSON.parse(row.tree_json), createdAt: row.created_at });
});

// Import a Postman collection JSON. Body: { json: <collection>, createSuite?: boolean }
collectionsRouter.post('/import', (req, res) => {
  const { json, createSuite } = req.body || {};
  let parsed;
  try {
    parsed = importCollection(typeof json === 'string' ? JSON.parse(json) : json);
  } catch (e: any) {
    return res.status(400).json({ error: `Import failed: ${e.message}` });
  }
  const id = newId();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO collections (id, name, raw_json, tree_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id, parsed.name, JSON.stringify(typeof json === 'string' ? JSON.parse(json) : json), JSON.stringify(parsed.tree), now,
  );

  let suiteId: string | null = null;
  if (createSuite !== false) {
    suiteId = newId();
    db.prepare(
      'INSERT INTO suites (id, name, description, collection_id, steps_json, variables_json, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      suiteId,
      parsed.name,
      `Suite generated from imported collection "${parsed.name}"`,
      id,
      JSON.stringify(parsed.steps),
      JSON.stringify(parsed.variables.map((v) => ({ ...v, secret: false }))),
      JSON.stringify(defaultSettings()),
      now,
      now,
    );
  }
  res.status(201).json({ id, name: parsed.name, suiteId, stepCount: parsed.steps.length });
});

collectionsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM collections WHERE id = ?').run(req.params.id);
  // suites keep working: they own their own copy of steps (copy-on-write)
  db.prepare('UPDATE suites SET collection_id = NULL WHERE collection_id = ?').run(req.params.id);
  res.json({ ok: true });
});
