import { Router } from 'express';
import { db } from '../db.js';
import type { GlobalVariable } from '../types.js';

export const variablesRouter = Router();

export function getGlobals(): GlobalVariable[] {
  const rows = db.prepare('SELECT * FROM global_variables ORDER BY key').all() as Array<{ key: string; value: string; secret: number }>;
  return rows.map((r) => ({ key: r.key, value: r.value, secret: !!r.secret }));
}

export function setGlobal(key: string, value: string, secret = false) {
  db.prepare(
    'INSERT INTO global_variables (key, value, secret) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret',
  ).run(key, value, secret ? 1 : 0);
}

variablesRouter.get('/', (_req, res) => {
  res.json(getGlobals());
});

// Upsert one variable: { key, value, secret? }
variablesRouter.post('/', (req, res) => {
  const { key, value, secret } = req.body || {};
  if (!key || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
    return res.status(400).json({ error: 'Variable key must start with a letter/underscore and contain only letters, digits, _ . -' });
  }
  setGlobal(key, String(value ?? ''), !!secret);
  res.status(201).json({ key, value: String(value ?? ''), secret: !!secret });
});

// Bulk replace: [{key, value, secret}]
variablesRouter.put('/', (req, res) => {
  const list = req.body;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Expected an array of variables' });
  for (const v of list) {
    if (!v?.key || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(v.key)) {
      return res.status(400).json({ error: `Invalid variable key: ${v?.key}` });
    }
  }
  db.exec('DELETE FROM global_variables');
  for (const v of list) setGlobal(v.key, String(v.value ?? ''), !!v.secret);
  res.json(getGlobals());
});

variablesRouter.delete('/:key', (req, res) => {
  db.prepare('DELETE FROM global_variables WHERE key = ?').run(req.params.key);
  res.json({ ok: true });
});
