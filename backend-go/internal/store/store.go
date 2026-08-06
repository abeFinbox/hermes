// Package store owns the SQLite connection and low-level persistence. It opens
// the SAME data/app.db and data/jwt-secret as the Node backend (backend/src/db.ts),
// so the two backends share users, suites, runs, files and JWT signing key —
// which is what lets the UI toggle between them without losing session or data.
package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/finbox/hermes/backend-go/internal/model"
	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

var (
	DB        *sql.DB
	DataDir   string
	FilesDir  string
	JWTSecret string
)

const schema = `
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

-- ---- Hera (k6 load testing) ----
-- Kept in its own tables rather than reusing the runs table: a load test has no
-- per-step pass/fail truth, it has percentiles, throughput and error rates.
-- Schema text is identical in backend/src/db.ts.
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
`

// Init opens the shared database and resolves the shared JWT secret.
func Init() error {
	DataDir = os.Getenv("DATA_DIR")
	if DataDir == "" {
		// default mirrors backend/src/db.ts: <backend>/data. From backend-go we
		// point at the sibling backend/data so both processes share one store.
		DataDir = filepath.Join("..", "backend", "data")
	}
	if err := os.MkdirAll(DataDir, 0o755); err != nil {
		return err
	}
	FilesDir = filepath.Join(DataDir, "files")
	if err := os.MkdirAll(FilesDir, 0o755); err != nil {
		return err
	}

	dbPath := filepath.Join(DataDir, "app.db")
	// busy_timeout lets a write wait out a lock held by the other backend
	// instead of failing immediately; WAL matches what Node set.
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)", url.PathEscape(dbPath))
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	if _, err := db.Exec(schema); err != nil {
		return err
	}
	DB = db
	if err := ensureRoleColumn(); err != nil {
		return err
	}
	if err := ensureColumn("captcha_exempt", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := ReapStaleHeraRuns(); err != nil {
		return err
	}

	return initSecret()
}

// InstanceID identifies this process. A Hera run records the instance that owns
// it, so a restart can tell its own abandoned rows apart from a run that is
// still live on the other backend against the same database file.
var InstanceID = model.NewID()

// HeraActiveStatuses are the statuses whose runs have a live k6 child, or should.
var HeraActiveStatuses = []string{"queued", "ramping", "running", "stopping"}

// HeraStaleAfter is how long a Hera row may go without a heartbeat before it is
// considered abandoned. The runner heartbeats every 10s, so this is six misses.
const HeraStaleAfter = 60 * time.Second

// ReapStaleHeraRuns marks Hera rows abandoned by a crashed or restarted process.
//
// The existing suite runner leaves 'running' rows behind forever on restart —
// Hera must not inherit that, because a stale row would also hold the hera_lock
// and block every future run.
//
// Staleness is decided by heartbeat age, NOT by "is this row mine", because the
// other backend may legitimately be running a load test against this same file
// right now. Its heartbeat is fresh, so it survives.
func ReapStaleHeraRuns() error {
	now := time.Now().UTC()
	cutoff := now.Add(-HeraStaleAfter).Format(time.RFC3339)
	placeholders := make([]string, len(HeraActiveStatuses))
	args := []interface{}{now.Format(time.RFC3339)}
	for i, s := range HeraActiveStatuses {
		placeholders[i] = "?"
		args = append(args, s)
	}
	args = append(args, cutoff)
	res, err := DB.Exec(
		`UPDATE hera_runs SET status = 'interrupted', finished_at = ?
		 WHERE status IN (`+strings.Join(placeholders, ", ")+`) AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
		args...,
	)
	if err != nil {
		return err
	}
	// Release the lock only if it is held by one of those abandoned runs.
	if _, err := DB.Exec(
		`UPDATE hera_lock SET run_id = NULL, owner = NULL, heartbeat_at = NULL
		 WHERE id = 1 AND (heartbeat_at IS NULL OR heartbeat_at < ?)`, cutoff,
	); err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		fmt.Printf("[hera] marked %d abandoned load-test run(s) as interrupted\n", n)
	}
	return nil
}

// ensureRoleColumn adds users.role (admin | moderator | npc), mirroring the
// migration in backend/src/db.ts. Idempotent and shared with the Node backend.
func ensureRoleColumn() error {
	rows, err := DB.Query("PRAGMA table_info(users)")
	if err != nil {
		return err
	}
	defer rows.Close()
	hasRole := false
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if name == "role" {
			hasRole = true
		}
	}
	rows.Close()
	if hasRole {
		return nil
	}
	if _, err := DB.Exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'moderator'"); err != nil {
		return err
	}
	_, err = DB.Exec("UPDATE users SET role = 'admin' WHERE is_admin = 1")
	return err
}

// ensureColumn adds a column to users if it isn't already present (idempotent,
// shared with the Node backend). Used for the captcha_exempt migration.
func ensureColumn(name, decl string) error {
	rows, err := DB.Query("PRAGMA table_info(users)")
	if err != nil {
		return err
	}
	defer rows.Close()
	has := false
	for rows.Next() {
		var cid int
		var cname, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &cname, &ctype, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if cname == name {
			has = true
		}
	}
	rows.Close()
	if has {
		return nil
	}
	_, err = DB.Exec("ALTER TABLE users ADD COLUMN " + name + " " + decl)
	return err
}

func initSecret() error {
	if s := os.Getenv("JWT_SECRET"); s != "" {
		JWTSecret = s
		return nil
	}
	secretFile := filepath.Join(DataDir, "jwt-secret")
	if b, err := os.ReadFile(secretFile); err == nil {
		JWTSecret = strings.TrimSpace(string(b))
		return nil
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return err
	}
	JWTSecret = hex.EncodeToString(buf)
	return os.WriteFile(secretFile, []byte(JWTSecret), 0o600)
}

// SeedAdmin bootstraps the admin user when the users table is empty, matching
// backend/src/db.ts seedAdmin().
func SeedAdmin() error {
	var count int
	if err := DB.QueryRow("SELECT COUNT(*) FROM users").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	username := envOr("ADMIN_USER", "admin")
	password := envOr("ADMIN_PASSWORD", "admin123")
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 10)
	if err != nil {
		return err
	}
	_, err = DB.Exec(
		"INSERT INTO users (id, username, password_hash, is_admin, role, created_at) VALUES (?, ?, ?, 1, 'admin', ?)",
		model.NewID(), username, string(hash), time.Now().UTC().Format(time.RFC3339Nano),
	)
	if err == nil {
		fmt.Printf("[bootstrap] seeded admin user %q\n", username)
	}
	return err
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// ---- global variables (shared by executor + variables route) ----

func GetGlobals() ([]model.GlobalVariable, error) {
	rows, err := DB.Query("SELECT key, value, secret FROM global_variables ORDER BY key")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.GlobalVariable{}
	for rows.Next() {
		var g model.GlobalVariable
		var secret int
		if err := rows.Scan(&g.Key, &g.Value, &secret); err != nil {
			return nil, err
		}
		g.Secret = secret != 0
		out = append(out, g)
	}
	return out, rows.Err()
}

func SetGlobal(key, value string, secret bool) error {
	s := 0
	if secret {
		s = 1
	}
	_, err := DB.Exec(
		"INSERT INTO global_variables (key, value, secret) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret",
		key, value, s,
	)
	return err
}

// ---- files ----

type FileRow struct {
	ID           string
	OriginalName string
	StoredName   string
	Size         int64
	Mime         string
	CreatedAt    string
}

func GetFileRow(id string) (*FileRow, error) {
	var r FileRow
	err := DB.QueryRow("SELECT id, original_name, stored_name, size, mime, created_at FROM files WHERE id = ?", id).
		Scan(&r.ID, &r.OriginalName, &r.StoredName, &r.Size, &r.Mime, &r.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// ResolveStoredFile returns the on-disk path + metadata for a stored file id,
// used by the executor to attach files to multipart requests.
func ResolveStoredFile(id string) (path, name, mime string, ok bool) {
	r, err := GetFileRow(id)
	if err != nil || r == nil {
		return "", "", "", false
	}
	return filepath.Join(FilesDir, r.StoredName), r.OriginalName, r.Mime, true
}
