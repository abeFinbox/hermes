import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

// Managed store for files attached to requests (multipart/form-data parts).
export const FILES_DIR = join(DATA_DIR, 'files');
mkdirSync(FILES_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'app.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    tree_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS suites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    collection_id TEXT,
    steps_json TEXT NOT NULL,
    variables_json TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS global_variables (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    secret INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    suite_id TEXT NOT NULL,
    suite_name TEXT NOT NULL,
    status TEXT NOT NULL,
    cycles INTEGER NOT NULL,
    stop_on_failure INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    cycle_results_json TEXT NOT NULL,
    summary_json TEXT
  );
`);

// --- Migration: users.role (admin | moderator | npc) ---
// Added in 2.0. Existing admins map to 'admin', everyone else to 'moderator'
// (closest to the old member capability). Idempotent + shared with the Go
// backend, so whichever process starts first performs it; the other no-ops.
function ensureRoleColumn() {
  const cols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'moderator'");
    db.exec("UPDATE users SET role = 'admin' WHERE is_admin = 1");
  }
}
ensureRoleColumn();

// --- Migration: users.captcha_exempt (2.0) — allowlisted accounts skip the
// login captcha. Idempotent + shared with the Go backend. ---
function ensureCaptchaExemptColumn() {
  const cols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'captcha_exempt')) {
    db.exec('ALTER TABLE users ADD COLUMN captcha_exempt INTEGER NOT NULL DEFAULT 0');
  }
}
ensureCaptchaExemptColumn();

export type Role = 'admin' | 'moderator' | 'npc';

// --- JWT secret: generated once, persisted so restarts keep sessions ---
const secretFile = join(DATA_DIR, 'jwt-secret');
export const JWT_SECRET: string = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (existsSync(secretFile)) return readFileSync(secretFile, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  writeFileSync(secretFile, s, { mode: 0o600 });
  return s;
})();

// --- Bootstrap admin user ---
export function seedAdmin() {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (count === 0) {
    const username = process.env.ADMIN_USER || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    db.prepare("INSERT INTO users (id, username, password_hash, is_admin, role, created_at) VALUES (?, ?, ?, 1, 'admin', ?)").run(
      crypto.randomUUID(),
      username,
      bcrypt.hashSync(password, 10),
      new Date().toISOString(),
    );
    console.log(`[bootstrap] seeded admin user "${username}"${process.env.ADMIN_PASSWORD ? '' : ' with default password "admin123" — change it in Settings'}`);
  }
}
