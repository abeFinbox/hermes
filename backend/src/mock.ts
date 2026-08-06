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
 *   POST /mock/job      {ms}                  -> { jobId } — an async job that completes later
 *   GET  /mock/job/:id                        -> { status: 'pending' | 'completed' }
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

/**
 * Async job pair — the shape real pipelines have: accept the work, then make the
 * caller poll until it finishes. This is what makes Hera's polling support
 * testable without an external service.
 *
 * Deliberately STATELESS: the completion time is encoded in the job id, so a
 * load test creating thousands of jobs grows no server-side map and the two
 * backends need no shared state to agree. Ids are forgeable, which is fine for a
 * demo API with no auth.
 *
 *   job-<readyAtEpochMs>-<totalMs>-<seq>
 */
let jobSeq = 0;
const JOB_ID_RE = /^job-(\d+)-(\d+)-\d+$/;

mockRouter.post('/job', (req, res) => {
  const raw = Number(req.body?.ms ?? req.query.ms);
  const ms = Math.max(1, Math.min(10000, Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1500));
  const readyAt = Date.now() + ms;
  res.status(202).json({
    jobId: `job-${readyAt}-${ms}-${++jobSeq}`,
    status: 'pending',
    totalMs: ms,
    pollAfterMs: Math.min(500, ms),
  });
});

mockRouter.get('/job/:id', (req, res) => {
  const m = JOB_ID_RE.exec(String(req.params.id));
  if (!m) return res.status(404).json({ error: 'unknown job id' });
  const readyAt = Number(m[1]);
  const totalMs = Number(m[2]);
  const remaining = readyAt - Date.now();
  if (remaining > 0) {
    // never reports 100 while pending, so a stop condition on progress works too
    const progress = Math.max(0, Math.min(99, Math.floor(((totalMs - remaining) / totalMs) * 100)));
    return res.json({ jobId: req.params.id, status: 'pending', progress });
  }
  res.json({ jobId: req.params.id, status: 'completed', progress: 100, result: { tookMs: totalMs } });
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
