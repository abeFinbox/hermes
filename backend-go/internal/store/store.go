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

	return initSecret()
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
