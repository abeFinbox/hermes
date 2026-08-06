package hera

import (
	"database/sql"
	"time"

	"github.com/finbox/hermes/backend-go/internal/store"
)

// Cross-process single-run lock.
//
// Both backends open the SAME SQLite file, so an in-process mutex would allow
// one concurrent run EACH — twice the intended load on the target and twice the
// CPU contention here. The lock therefore lives in a table row.
//
// A crashed owner releases itself: acquisition succeeds when the current
// heartbeat is older than store.HeraStaleAfter, so nothing can wedge the feature
// permanently.
//
// Mirrors backend/src/hera/lock.ts.

type LockHolder struct {
	RunID       string
	Owner       string
	HeartbeatAt string
}

// AcquireLock tries to take the lock for a run. Returns nil on success, or the
// current holder.
func AcquireLock(runID string) *LockHolder {
	now := time.Now().UTC()
	cutoff := now.Add(-store.HeraStaleAfter).Format(time.RFC3339)
	res, err := store.DB.Exec(
		`UPDATE hera_lock SET run_id = ?, owner = ?, heartbeat_at = ?
		 WHERE id = 1 AND (run_id IS NULL OR heartbeat_at IS NULL OR heartbeat_at < ?)`,
		runID, store.InstanceID, now.Format(time.RFC3339), cutoff,
	)
	if err == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			return nil
		}
	}
	var h LockHolder
	var runIDNull, ownerNull, hbNull sql.NullString
	if err := store.DB.QueryRow("SELECT run_id, owner, heartbeat_at FROM hera_lock WHERE id = 1").
		Scan(&runIDNull, &ownerNull, &hbNull); err != nil {
		return nil
	}
	h.RunID = runIDNull.String
	h.Owner = ownerNull.String
	h.HeartbeatAt = hbNull.String
	return &h
}

// Heartbeat keeps the lock (and the run row) alive. Called on every persist.
func Heartbeat(runID string) {
	now := time.Now().UTC().Format(time.RFC3339)
	_, _ = store.DB.Exec("UPDATE hera_lock SET heartbeat_at = ? WHERE id = 1 AND run_id = ?", now, runID)
	_, _ = store.DB.Exec("UPDATE hera_runs SET heartbeat_at = ? WHERE id = ?", now, runID)
}

// ReleaseLock releases the lock, but only if this run still holds it.
func ReleaseLock(runID string) {
	_, _ = store.DB.Exec(
		"UPDATE hera_lock SET run_id = NULL, owner = NULL, heartbeat_at = NULL WHERE id = 1 AND run_id = ?", runID)
}
