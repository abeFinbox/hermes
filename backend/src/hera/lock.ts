import { db, HERA_STALE_MS, INSTANCE_ID } from '../db.js';

/**
 * Cross-process single-run lock.
 *
 * Both backends open the SAME SQLite file, so an in-process mutex would allow
 * one concurrent run EACH — twice the intended load on the target and twice the
 * CPU contention here. The lock therefore lives in a table row.
 *
 * A crashed owner releases itself: acquisition succeeds when the current
 * heartbeat is older than HERA_STALE_MS, so nothing can wedge the feature
 * permanently.
 *
 * Mirrors backend-go/internal/hera/lock.go.
 */

export interface LockHolder {
  runId: string;
  owner: string;
  heartbeatAt: string;
}

/** Try to take the lock for a run. Returns null on success, or the current holder. */
export function acquireLock(runId: string): LockHolder | null {
  const now = new Date();
  const cutoff = new Date(now.getTime() - HERA_STALE_MS).toISOString();
  const res = db
    .prepare(
      `UPDATE hera_lock SET run_id = ?, owner = ?, heartbeat_at = ?
       WHERE id = 1 AND (run_id IS NULL OR heartbeat_at IS NULL OR heartbeat_at < ?)`,
    )
    .run(runId, INSTANCE_ID, now.toISOString(), cutoff);
  if (Number(res.changes || 0) > 0) return null;
  const row = db.prepare('SELECT run_id, owner, heartbeat_at FROM hera_lock WHERE id = 1').get() as
    | { run_id: string; owner: string; heartbeat_at: string }
    | undefined;
  return row ? { runId: row.run_id, owner: row.owner, heartbeatAt: row.heartbeat_at } : null;
}

/** Keep the lock (and the run row) alive. Called on every progress persist. */
export function heartbeat(runId: string): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE hera_lock SET heartbeat_at = ? WHERE id = 1 AND run_id = ?').run(now, runId);
  db.prepare('UPDATE hera_runs SET heartbeat_at = ? WHERE id = ?').run(now, runId);
}

/** Release the lock, but only if this run still holds it. */
export function releaseLock(runId: string): void {
  db.prepare(
    'UPDATE hera_lock SET run_id = NULL, owner = NULL, heartbeat_at = NULL WHERE id = 1 AND run_id = ?',
  ).run(runId);
}

/** The run currently holding the lock, if it is still fresh. */
export function currentHolder(): LockHolder | null {
  const cutoff = new Date(Date.now() - HERA_STALE_MS).toISOString();
  const row = db
    .prepare(
      `SELECT run_id, owner, heartbeat_at FROM hera_lock
       WHERE id = 1 AND run_id IS NOT NULL AND heartbeat_at IS NOT NULL AND heartbeat_at >= ?`,
    )
    .get(cutoff) as { run_id: string; owner: string; heartbeat_at: string } | undefined;
  return row ? { runId: row.run_id, owner: row.owner, heartbeatAt: row.heartbeat_at } : null;
}
