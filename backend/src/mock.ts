import { Router } from 'express';
import multer from 'multer';

/**
 * Built-in demo API — lets you try the whole flow (chaining, captures,
 * validations) without any external service. Not behind auth on purpose.
 *
 *   POST /mock/login    {username, password}  -> { token, user: {id, name} }
 *   GET  /mock/profile  (Bearer token)        -> { id, name, email, plan }
 *   GET  /mock/items    (Bearer token)        -> { items: [...], count }
 *   POST /mock/items    (Bearer token) {name} -> { id, name, createdAt }
 *   GET  /mock/slow?ms=1500                   -> delayed response
 *   POST /mock/upload   (multipart/form-data) -> echoes text fields + file metadata
 */
export const mockRouter = Router();

const mockUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const MOCK_TOKEN_PREFIX = 'mock-token-';

function checkBearer(req: any): boolean {
  const h = String(req.headers['authorization'] || '');
  return h.startsWith('Bearer ' + MOCK_TOKEN_PREFIX);
}

mockRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (password === 'wrong') return res.status(401).json({ error: 'invalid credentials' });
  res.json({
    token: MOCK_TOKEN_PREFIX + Buffer.from(String(username)).toString('hex'),
    user: { id: 'u-1001', name: username },
  });
});

mockRouter.get('/profile', (req, res) => {
  if (!checkBearer(req)) return res.status(401).json({ error: 'missing or invalid bearer token' });
  res.json({ id: 'u-1001', name: 'demo user', email: 'demo@example.com', plan: 'pro' });
});

let itemSeq = 3;
mockRouter.get('/items', (req, res) => {
  if (!checkBearer(req)) return res.status(401).json({ error: 'missing or invalid bearer token' });
  res.json({
    items: [
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
      { id: 3, name: 'gamma' },
    ],
    count: 3,
  });
});

mockRouter.post('/items', (req, res) => {
  if (!checkBearer(req)) return res.status(401).json({ error: 'missing or invalid bearer token' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  res.status(201).json({ id: ++itemSeq, name, createdAt: new Date().toISOString() });
});

mockRouter.get('/slow', async (req, res) => {
  const ms = Math.min(10000, Number(req.query.ms) || 1500);
  await new Promise((r) => setTimeout(r, ms));
  res.json({ delayedMs: ms });
});

// echoes back what a multipart/form-data upload contained — handy for testing file attachments
mockRouter.post('/upload', mockUpload.any(), (req, res) => {
  const uploaded = (req.files as Express.Multer.File[] | undefined) || [];
  res.json({
    receivedAt: new Date().toISOString(),
    fields: req.body || {},
    files: uploaded.map((f) => ({ field: f.fieldname, filename: f.originalname, mime: f.mimetype, size: f.size })),
    fileCount: uploaded.length,
  });
});
