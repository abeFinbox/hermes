import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..'); // repo root (docs live there)

/** Only these named docs are exposed — no arbitrary file access. */
const DOCS: Record<string, { file: string; title: string }> = {
  readme: { file: 'README.md', title: 'README' },
  manual: { file: 'USER_MANUAL.md', title: 'User Manual' },
  deploy: { file: 'HOW-TO-DEPLOY.md', title: 'How to Deploy' },
};

export const docsRouter = Router();

docsRouter.get('/', (_req, res) => {
  res.json(Object.entries(DOCS).map(([key, d]) => ({ key, title: d.title })));
});

docsRouter.get('/:key', (req, res) => {
  const doc = DOCS[req.params.key];
  if (!doc) return res.status(404).json({ error: 'Unknown document' });
  const path = join(ROOT, doc.file);
  if (!existsSync(path)) return res.status(404).json({ error: `${doc.file} is not available in this build` });
  res.json({ key: req.params.key, title: doc.title, markdown: readFileSync(path, 'utf8') });
});
