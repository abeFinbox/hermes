import type { Role } from './types';

/**
 * Capability matrix per user role. Mirrors the server-side enforcement in
 * backend/src/auth.ts (enforcePermissions) and backend-go auth.EnforcePermissions —
 * the backend is the security boundary; these flags drive UI affordances.
 *
 *  admin     — full access (manage users, delete anything, switch engine)
 *  moderator — create/edit suites + appearance, but NO deletion in any tab
 *  npc       — read-only + execute runs; no admin, no docs
 */
export interface Perms {
  role: Role;
  canCreate: boolean; // create/edit suites, import collections, edit variables, upload files
  canDelete: boolean; // delete in any tab
  canExecute: boolean; // run/execute suites
  canManageUsers: boolean;
  canViewDocs: boolean;
  canAppearance: boolean;
  canSwitchEngine: boolean;
}

export function permsFor(role: Role | undefined, isAdmin?: boolean): Perms {
  // Robustness: if role is missing (e.g. a stale session whose /me predates the
  // role feature), recover admin from the isAdmin flag so an admin is never
  // silently demoted. Unknown non-admins fall back to the least-privileged npc.
  const r: Role = role === 'admin' || role === 'moderator' || role === 'npc' ? role : isAdmin ? 'admin' : 'npc';
  const admin = r === 'admin';
  const mod = r === 'moderator';
  return {
    role: r,
    canCreate: admin || mod,
    canDelete: admin,
    canExecute: true,
    canManageUsers: admin,
    canViewDocs: admin || mod,
    canAppearance: admin || mod,
    canSwitchEngine: admin,
  };
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  moderator: 'Moderator',
  npc: 'NPC (read-only)',
};
