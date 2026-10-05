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
  -- Wait out a write lock held by the other backend instead of failing
  -- instantly. Matches the busy_timeout(5000) the Go backend sets in its DSN
  -- (backend-go/internal/store/store.go); both processes share this file.
  PRAGMA busy_timeout = 5000;

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

  -- ---- Environments: named, reusable variable sets (dev, staging, custom...) ----
  -- One environment is chosen per run (suite default, overridable at launch) and
  -- sits above the globals in precedence:
  --   runtime > environment > global > suite
  -- Kept in its own tables rather than a scope column on global_variables so that
  -- deleting an environment cannot touch the globals every suite depends on.
  -- Schema text is identical in backend-go/internal/store/store.go.
  CREATE TABLE IF NOT EXISTS environments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS environment_variables (
    env_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    secret INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (env_id, key)
  );
  CREATE INDEX IF NOT EXISTS idx_environment_variables_env ON environment_variables(env_id);

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

  -- ---- Hera (k6 load testing) ----
  -- Kept in its own tables rather than reusing the runs table: a load test has no
  -- per-step pass/fail truth, it has percentiles, throughput and error rates.
  -- Schema text is identical in backend-go/internal/store/store.go.
  CREATE TABLE IF NOT EXISTS hera_runs (
    id TEXT PRIMARY KEY,
    suite_id TEXT NOT NULL,
    suite_name TEXT NOT NULL,
    status TEXT NOT NULL,
    config_json TEXT NOT NULL,
    applied_config_json TEXT NOT NULL,
    target_hosts_json TEXT NOT NULL DEFAULT '[]',
    k6_version TEXT NOT NULL DEFAULT '',
    backend TEXT NOT NULL DEFAULT '',
    owner_instance TEXT NOT NULL DEFAULT '',
    heartbeat_at TEXT,
    exit_code INTEGER,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    summary_json TEXT,
    samples_json TEXT NOT NULL DEFAULT '[]',
    steps_json TEXT NOT NULL DEFAULT '[]',
    stderr_tail TEXT NOT NULL DEFAULT '',
    overhead_ms REAL,
    confidence TEXT NOT NULL DEFAULT 'unknown',
    created_by_user_id TEXT NOT NULL DEFAULT '',
    created_by_username TEXT NOT NULL DEFAULT '',
    created_by_role TEXT NOT NULL DEFAULT '',
    source_ip TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_hera_runs_started ON hera_runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_hera_runs_suite ON hera_runs(suite_id);

  -- Append-only. Deliberately has no DELETE route: an admin removing a run
  -- must not be able to erase the record of what Hera was aimed at.
  CREATE TABLE IF NOT EXISTS hera_audit (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    event TEXT NOT NULL,
    run_id TEXT,
    user_id TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    source_ip TEXT NOT NULL DEFAULT '',
    backend TEXT NOT NULL DEFAULT '',
    suite_id TEXT NOT NULL DEFAULT '',
    target_hosts_json TEXT NOT NULL DEFAULT '[]',
    detail_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_hera_audit_at ON hera_audit(at DESC);

  -- Single-row cross-process lock. Both backends share this file, so an
  -- in-process mutex would allow one run EACH — twice the intended load.
  CREATE TABLE IF NOT EXISTS hera_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    run_id TEXT,
    owner TEXT,
    heartbeat_at TEXT
  );
  INSERT OR IGNORE INTO hera_lock (id, run_id, owner, heartbeat_at) VALUES (1, NULL, NULL, NULL);
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

/** Add a column if it isn't already there. Idempotent + shared with the Go backend. */
function ensureColumn(table: string, name: string, decl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}

// --- Migration: environment selection (2.1) ---
// A suite remembers its default environment; a run records the environment it
// actually used, by id AND name, so the record survives the environment being
// renamed or deleted. Mirrored in backend-go/internal/store/store.go.
ensureColumn('suites', 'default_env_id', 'TEXT');
ensureColumn('runs', 'env_id', 'TEXT');
ensureColumn('runs', 'env_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('hera_runs', 'env_id', 'TEXT');
ensureColumn('hera_runs', 'env_name', "TEXT NOT NULL DEFAULT ''");

export type Role = 'admin' | 'moderator' | 'npc';

// This process's identity. A Hera run records the instance that owns it, so a
// restart can tell its own abandoned rows apart from a run that is still live
// on the other backend against the same database file.
export const INSTANCE_ID: string = crypto.randomUUID();

/** Active Hera statuses — a run in any of these has a live k6 child, or should. */
export const HERA_ACTIVE_STATUSES = ['queued', 'ramping', 'running', 'stopping'] as const;

// How long a Hera row may go without a heartbeat before it is considered
// abandoned. The runner heartbeats every 10s, so 60s is six missed beats.
export const HERA_STALE_MS = 60_000;

/**
 * Reap Hera rows abandoned by a crashed or restarted process.
 *
 * The existing suite runner leaves 'running' rows behind forever on restart
 * (see the note in runner/executor.ts) — Hera must not inherit that, because a
 * stale row would also hold the hera_lock and block every future run.
 *
 * Staleness is decided by heartbeat age, NOT by "is this row mine", because the
 * other backend may legitimately be running a load test against this same file
 * right now. Its heartbeat is fresh, so it survives.
 */
export function reapStaleHeraRuns(): number {
  const now = new Date();
  const cutoff = new Date(now.getTime() - HERA_STALE_MS).toISOString();
  const placeholders = HERA_ACTIVE_STATUSES.map(() => '?').join(', ');
  const res = db
    .prepare(
      `UPDATE hera_runs SET status = 'interrupted', finished_at = ?
       WHERE status IN (${placeholders}) AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
    )
    .run(now.toISOString(), ...HERA_ACTIVE_STATUSES, cutoff);
  // Release the lock only if it is held by one of those abandoned runs.
  db.prepare(
    `UPDATE hera_lock SET run_id = NULL, owner = NULL, heartbeat_at = NULL
     WHERE id = 1 AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
  ).run(cutoff);
  const n = Number(res.changes || 0);
  if (n > 0) console.log(`[hera] marked ${n} abandoned load-test run(s) as interrupted`);
  return n;
}
// Run at startup, mirroring store.Init() in the Go backend.
reapStaleHeraRuns();

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
