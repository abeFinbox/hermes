import { Router, type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import svgCaptcha from 'svg-captcha';
import { db, JWT_SECRET, type Role } from './db.js';

const ROLES: Role[] = ['admin', 'moderator', 'npc'];

const COOKIE = 'ats_token';
const CAPTCHA_TTL_MS = 5 * 60 * 1000;

interface CaptchaEntry {
  text: string;
  expires: number;
}
const captchas = new Map<string, CaptchaEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [id, c] of captchas) if (c.expires < now) captchas.delete(id);
}, 60_000).unref();

// naive per-IP login rate limit: 10 attempts / minute
const attempts = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  attempts.set(ip, list);
  return list.length > 10;
}

export interface AuthedRequest extends Request {
  user?: { id: string; username: string; isAdmin: boolean; role: Role };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; username: string; isAdmin: boolean; role?: Role };
    // tokens minted before roles existed carry only isAdmin — derive a role
    const role: Role = payload.role || (payload.isAdmin ? 'admin' : 'moderator');
    req.user = { id: payload.sub, username: payload.username, isAdmin: role === 'admin', role };
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

/**
 * Role-based permission gate for the data API (mounted after requireAuth).
 * `path` here is relative to the /api mount (e.g. "/suites/123").
 *  - GET is always allowed, except admin-only Docs are hidden from npc.
 *  - Running suites (POST /runs, /runs/step, /runs/:id/stop|report) is allowed
 *    for every role — npc is "read-only + execute".
 *  - DELETE anywhere is admin-only (moderators cannot delete).
 *  - Other writes (create/edit) need admin or moderator; npc is read-only.
 */
export function enforcePermissions(req: AuthedRequest, res: Response, next: NextFunction) {
  const role = req.user!.role;
  const m = req.method;
  const p = req.path;

  if (m === 'GET') {
    if (p.startsWith('/docs') && role === 'npc') {
      return res.status(403).json({ error: 'Your role does not have access to the docs' });
    }
    return next();
  }

  // suite/run execution — allowed for all roles.
  //
  // NOTE ON HERA: only the STOP route is listed. Stopping is a safety action, so
  // every role including read-only npc must be able to hit the brakes. Starting
  // a load test is deliberately NOT here — it is gated to admin (or moderator
  // with HERA_ALLOW_MODERATOR=1) inside routes/hera.ts. Do not "fix" this by
  // pattern-matching the /runs entries above.
  const isExecute =
    (p === '/runs' && m === 'POST') ||
    (p === '/runs/step' && m === 'POST') ||
    (/^\/runs\/[^/]+\/(stop|report)$/.test(p) && m === 'POST') ||
    (/^\/hera\/[^/]+\/stop$/.test(p) && m === 'POST');
  if (isExecute) return next();

  if (m === 'DELETE') {
    if (role === 'admin') return next();
    return res.status(403).json({ error: 'Your role cannot delete items' });
  }

  // remaining POST/PUT are create/edit actions
  if (role === 'admin' || role === 'moderator') return next();
  return res.status(403).json({ error: 'Your role has read-only access' });
}

export const authRouter = Router();

authRouter.get('/captcha', (_req, res) => {
  const c = svgCaptcha.create({ size: 5, noise: 3, ignoreChars: '0o1ilI', color: false });
  const id = crypto.randomUUID();
  captchas.set(id, { text: c.text.toLowerCase(), expires: Date.now() + CAPTCHA_TTL_MS });
  res.json({ id, svg: c.data });
});

// Lets the login form hide the captcha for allowlisted accounts. Returns
// required:false ONLY for an existing captcha-exempt user, so it reveals the
// exempt set but not the full user list.
authRouter.get('/captcha-required', (req, res) => {
  const username = String(req.query.username || '');
  const row = username
    ? (db.prepare('SELECT captcha_exempt FROM users WHERE username = ?').get(username) as { captcha_exempt: number } | undefined)
    : undefined;
  res.json({ required: !(row && row.captcha_exempt) });
});

authRouter.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });

  const { username, password, captchaId, captchaText } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | { id: string; username: string; password_hash: string; is_admin: number; role: Role; captcha_exempt: number }
    | undefined;

  // Skip the captcha for allowlisted accounts (users.captcha_exempt) or the
  // dev-only CAPTCHA_BYPASS. Everyone else must solve it. Rate limiting and
  // password auth still apply to exempt users.
  const bypass = process.env.CAPTCHA_BYPASS === '1' && captchaText === 'bypass';
  const exempt = !!(user && user.captcha_exempt) || bypass;
  if (!exempt) {
    if (!captchaId || !captchaText) {
      return res.status(400).json({ error: 'captcha is required' });
    }
    const entry = captchas.get(String(captchaId));
    captchas.delete(String(captchaId)); // single use
    if (!entry || entry.expires < Date.now() || entry.text !== String(captchaText).trim().toLowerCase()) {
      return res.status(400).json({ error: 'Captcha incorrect or expired', captchaFailed: true });
    }
  }

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const role: Role = user.role || (user.is_admin ? 'admin' : 'moderator');
  const token = jwt.sign({ sub: user.id, username: user.username, isAdmin: role === 'admin', role }, JWT_SECRET, {
    expiresIn: '12h',
  });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 });
  res.json({ id: user.id, username: user.username, isAdmin: role === 'admin', role });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req: AuthedRequest, res) => {
  res.json(req.user);
});

authRouter.post('/change-password', requireAuth, (req: AuthedRequest, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string } | undefined;
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.user!.id);
  res.json({ ok: true });
});

// --- admin user management ---
export const usersRouter = Router();
usersRouter.use(requireAuth, requireAdmin);

usersRouter.get('/', (_req, res) => {
  const rows = db.prepare('SELECT id, username, is_admin, role, captcha_exempt, created_at FROM users ORDER BY created_at').all() as Array<{
    id: string; username: string; is_admin: number; role: Role; captcha_exempt: number; created_at: string;
  }>;
  res.json(rows.map((r) => ({
    id: r.id, username: r.username, role: r.role || (r.is_admin ? 'admin' : 'moderator'),
    isAdmin: (r.role || (r.is_admin ? 'admin' : 'moderator')) === 'admin',
    captchaExempt: !!r.captcha_exempt, createdAt: r.created_at,
  })));
});

usersRouter.post('/', (req, res) => {
  const { username, password, role, captchaExempt } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const r: Role = ROLES.includes(role) ? role : 'moderator';
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username already exists' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, is_admin, role, captcha_exempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, username, bcrypt.hashSync(password, 10), r === 'admin' ? 1 : 0, r, captchaExempt ? 1 : 0, new Date().toISOString(),
  );
  res.status(201).json({ id, username, role: r, isAdmin: r === 'admin', captchaExempt: !!captchaExempt });
});

// Toggle captcha exemption (and optionally role) for a user.
usersRouter.patch('/:id', (req, res) => {
  const { captchaExempt, role } = req.body || {};
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  if (captchaExempt !== undefined) {
    db.prepare('UPDATE users SET captcha_exempt = ? WHERE id = ?').run(captchaExempt ? 1 : 0, req.params.id);
  }
  if (role !== undefined && ROLES.includes(role)) {
    db.prepare('UPDATE users SET role = ?, is_admin = ? WHERE id = ?').run(role, role === 'admin' ? 1 : 0, req.params.id);
  }
  res.json({ ok: true });
});

usersRouter.delete('/:id', (req: AuthedRequest, res) => {
  if (req.params.id === req.user!.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
