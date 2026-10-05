import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Info } from '../legends';
import { useToast } from '../ui';
import { useAuth } from '../App';
import { permsFor } from '../perms';
import type { Environment, EnvironmentVariable, GlobalVariable } from '../types';

/**
 * Variables page — one screen for every reusable variable scope.
 *
 * The tab strip is the scope selector: "Global" edits global_variables, every
 * other tab is an environment (dev, staging, custom...). Both tabs edit the same
 * shape of row, which is the point: an environment is not a different kind of
 * thing, it is a named set that resolves ABOVE the globals and below the suite.
 */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

type Row = { key: string; value: string; secret: boolean };
/** null = the Global tab; otherwise an environment id. */
type Scope = string | null;

export default function Variables() {
  const [globals, setGlobals] = useState<GlobalVariable[]>([]);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [scope, setScope] = useState<Scope>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState('');
  const toast = useToast();
  const { user } = useAuth();
  const perms = permsFor(user?.role, user?.isAdmin);

  const activeEnv = useMemo(() => envs.find((e) => e.id === scope) ?? null, [envs, scope]);

  const load = async (keepScope: Scope) => {
    try {
      const [g, e] = await Promise.all([
        api.get<GlobalVariable[]>('/api/variables'),
        api.get<Environment[]>('/api/environments'),
      ]);
      setGlobals(g);
      setEnvs(e);
      // A scope that vanished (deleted elsewhere) falls back to Global.
      const next = keepScope !== null && !e.some((x) => x.id === keepScope) ? null : keepScope;
      setScope(next);
      setRows(next === null ? g.map((v) => ({ ...v })) : (e.find((x) => x.id === next)?.variables ?? []).map((v) => ({ ...v })));
      setDirty(false);
      setReveal({});
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  useEffect(() => {
    void load(null);
  }, []);

  const switchScope = (next: Scope) => {
    if (dirty && !confirm('Discard unsaved changes on this tab?')) return;
    setScope(next);
    setRows(next === null ? globals.map((v) => ({ ...v })) : (envs.find((e) => e.id === next)?.variables ?? []).map((v) => ({ ...v })));
    setDirty(false);
    setReveal({});
    setRenaming('');
  };

  const update = (i: number, patch: Partial<Row>) => {
    setRows((v) => v.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setDirty(true);
  };
  const add = () => {
    setRows((v) => [...v, { key: '', value: '', secret: false }]);
    setDirty(true);
  };
  const remove = (i: number) => {
    setRows((v) => v.filter((_, j) => j !== i));
    setDirty(true);
  };

  /** Shared validation — the server enforces the same rules, this just fails faster. */
  const invalidReason = (): string | null => {
    const bad = rows.find((v) => !KEY_RE.test(v.key));
    if (bad !== undefined) {
      return `Invalid variable name: "${bad.key || '(empty)'}" — start with a letter/underscore, then letters, digits, _ . -`;
    }
    const seen = new Set<string>();
    for (const v of rows) {
      if (seen.has(v.key)) return `Duplicate variable name: ${v.key}`;
      seen.add(v.key);
    }
    return null;
  };

  const save = async () => {
    const bad = invalidReason();
    if (bad) return toast(bad, 'error');
    try {
      if (scope === null) {
        const saved = await api.put<GlobalVariable[]>('/api/variables', rows);
        setGlobals(saved);
        setRows(saved.map((v) => ({ ...v })));
        toast('Global variables saved');
      } else {
        const saved = await api.put<Environment>(`/api/environments/${scope}`, {
          variables: rows as EnvironmentVariable[],
        });
        setEnvs((list) => list.map((e) => (e.id === saved.id ? saved : e)));
        setRows(saved.variables.map((v) => ({ ...v })));
        toast(`Environment “${saved.name}” saved`);
      }
      setDirty(false);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const createEnv = async () => {
    const name = prompt('New environment name (e.g. dev, staging, local):', '')?.trim();
    if (!name) return;
    try {
      const created = await api.post<Environment>('/api/environments', { name, variables: [] });
      setEnvs((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
      setScope(created.id);
      setRows([]);
      setDirty(false);
      toast(`Environment “${created.name}” created`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const duplicateEnv = async () => {
    if (!activeEnv) return;
    try {
      const copy = await api.post<Environment>(`/api/environments/${activeEnv.id}/duplicate`);
      setEnvs((list) => [...list, copy].sort((a, b) => a.name.localeCompare(b.name)));
      setScope(copy.id);
      setRows(copy.variables.map((v) => ({ ...v })));
      setDirty(false);
      toast(`Copied to “${copy.name}”`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const renameEnv = async () => {
    if (!activeEnv) return;
    const name = renaming.trim();
    if (!name || name === activeEnv.name) return setRenaming('');
    try {
      const saved = await api.put<Environment>(`/api/environments/${activeEnv.id}`, { name });
      setEnvs((list) => list.map((e) => (e.id === saved.id ? saved : e)).sort((a, b) => a.name.localeCompare(b.name)));
      setRenaming('');
      toast(`Renamed to “${saved.name}”`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const deleteEnv = async () => {
    if (!activeEnv) return;
    if (!confirm(`Delete environment “${activeEnv.name}”? Suites using it fall back to globals + suite variables.`)) return;
    try {
      await api.del(`/api/environments/${activeEnv.id}`);
      toast(`Environment “${activeEnv.name}” deleted`);
      await load(null);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div>
      <div className="row mb">
        <h1 className="grow" style={{ margin: 0 }}>Variables</h1>
        {perms.canCreate && <button className="btn" onClick={add}>+ Add variable</button>}
        {perms.canCreate && <button className="btn primary" disabled={!dirty} onClick={() => void save()}>Save</button>}
        {!perms.canCreate && <span className="muted" style={{ fontSize: 12 }}>Read-only</span>}
      </div>

      {/* Scope strip: Global + one tab per environment. */}
      <div className="row mb" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <button className={`btn small ${scope === null ? 'primary' : ''}`} onClick={() => switchScope(null)}>
          Global
        </button>
        {envs.map((e) => (
          <button key={e.id} className={`btn small ${scope === e.id ? 'primary' : ''}`} onClick={() => switchScope(e.id)}>
            {e.name}
            <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>{e.variables.length}</span>
          </button>
        ))}
        {perms.canCreate && <button className="btn small" onClick={() => void createEnv()}>+ Environment</button>}
        {dirty && <span className="muted" style={{ fontSize: 12 }}>unsaved changes</span>}
      </div>

      {scope === null ? (
        <p className="muted">
          Available to every suite as <span className="mono">{'{{variableName}}'}</span>. Resolution order is
          {' '}<b>runtime → environment → global → suite</b>: a global here beats a suite variable of the same name, and the
          selected environment beats both. Captures with scope “global” write here automatically during runs.
        </p>
      ) : (
        <>
          <div className="row mb" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {renaming ? (
              <>
                <input
                  type="text"
                  value={renaming}
                  autoFocus
                  style={{ maxWidth: 220 }}
                  onChange={(ev) => setRenaming(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') void renameEnv();
                    if (ev.key === 'Escape') setRenaming('');
                  }}
                />
                <button className="btn small primary" onClick={() => void renameEnv()}>Rename</button>
                <button className="btn small" onClick={() => setRenaming('')}>Cancel</button>
              </>
            ) : (
              <>
                {perms.canCreate && <button className="btn small" onClick={() => setRenaming(activeEnv?.name ?? '')}>Rename</button>}
                {perms.canCreate && <button className="btn small" onClick={() => void duplicateEnv()}>Duplicate</button>}
                {perms.canDelete && <button className="btn small danger" onClick={() => void deleteEnv()}>Delete environment</button>}
              </>
            )}
          </div>
          <p className="muted">
            Environment <b>{activeEnv?.name}</b>. Pick it per suite (Suite editor) or per load test (Hera) — variables here override
            both globals and suite variables of the same name. Only values captured during the run itself win over them.
          </p>
        </>
      )}

      <table className="list">
        <thead>
          <tr>
            <th style={{ width: '28%' }}>Name</th>
            <th>Value</th>
            <th style={{ width: 110 }}>Secret<Info k="variables.secret" /></th>
            <th style={{ width: 60 }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v, i) => (
            <tr key={i}>
              <td><input type="text" value={v.key} placeholder="baseUrl" disabled={!perms.canCreate} onChange={(e) => update(i, { key: e.target.value })} /></td>
              <td>
                <div className="row">
                  <input
                    type={v.secret && !reveal[String(i)] ? 'password' : 'text'}
                    value={v.value}
                    disabled={!perms.canCreate}
                    onChange={(e) => update(i, { value: e.target.value })}
                  />
                  {v.secret && (
                    <button className="btn small" onClick={() => setReveal((r) => ({ ...r, [String(i)]: !r[String(i)] }))}>
                      {reveal[String(i)] ? 'hide' : 'show'}
                    </button>
                  )}
                </div>
              </td>
              <td><input type="checkbox" checked={v.secret} disabled={!perms.canCreate} onChange={(e) => update(i, { secret: e.target.checked })} /></td>
              <td>{perms.canDelete && <button className="btn small danger" onClick={() => remove(i)}>✕</button>}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={4} className="muted">{scope === null ? 'No global variables yet.' : 'No variables in this environment yet.'}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
