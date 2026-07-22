import { Router } from 'express';
import multer from 'multer';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { db, FILES_DIR } from '../db.js';
import { newId } from '../types.js';

export const filesRouter = Router();

// ---- store helpers ----

interface FileRow {
  id: string;
  original_name: string;
  stored_name: string;
  size: number;
  mime: string;
  created_at: string;
}

export interface StoredFileMeta {
  id: string;
  originalName: string;
  size: number;
  mime: string;
  createdAt: string;
}

function toMeta(r: FileRow): StoredFileMeta {
  return { id: r.id, originalName: r.original_name, size: r.size, mime: r.mime, createdAt: r.created_at };
}

export function getFileRow(id: string): FileRow | undefined {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as unknown as FileRow | undefined;
}

// Absolute path + metadata for a stored file, or null if the id is unknown.
// Used by the executor to attach files to multipart requests.
export function resolveStoredFile(id: string): { path: string; name: string; mime: string } | null {
  const row = getFileRow(id);
  if (!row) return null;
  return { path: join(FILES_DIR, row.stored_name), name: row.original_name, mime: row.mime };
}

// ---- upload handling ----

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file — matches ingress body limits in deploy docs

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, FILES_DIR),
    // store under an opaque random name; the original name is kept in the DB row
    filename: (_req, file, cb) => cb(null, `${newId()}${extOf(file.originalname)}`),
  }),
  limits: { fileSize: MAX_FILE_BYTES },
});

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, '') : '';
}

// ---- routes ----

filesRouter.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all() as unknown as FileRow[];
  res.json(rows.map(toMeta));
});

filesRouter.post('/', upload.array('files', 20), (req, res) => {
  const uploaded = (req.files as Express.Multer.File[] | undefined) || [];
  if (!uploaded.length) return res.status(400).json({ error: 'No files uploaded (field name must be "files")' });
  const now = new Date().toISOString();
  const created: StoredFileMeta[] = [];
  const insert = db.prepare('INSERT INTO files (id, original_name, stored_name, size, mime, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const f of uploaded) {
    const id = newId();
    insert.run(id, f.originalname, f.filename, f.size, f.mimetype || '', now);
    created.push({ id, originalName: f.originalname, size: f.size, mime: f.mimetype || '', createdAt: now });
  }
  res.status(201).json(created);
});

filesRouter.get('/:id/download', (req, res) => {
  const row = getFileRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${row.original_name.replace(/"/g, '')}"`);
  createReadStream(join(FILES_DIR, row.stored_name)).on('error', () => res.status(404).end()).pipe(res);
});

filesRouter.delete('/:id', async (req, res) => {
  const row = getFileRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'File not found' });
  db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
  await unlink(join(FILES_DIR, row.stored_name)).catch(() => {}); // row is source of truth; ignore missing blob
  res.json({ ok: true });
});
