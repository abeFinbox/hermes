import { useEffect, useState } from 'react';
import { api } from '../api';
import { Info } from '../legends';
import { useToast } from '../ui';
import { useAuth } from '../App';
import { permsFor } from '../perms';
import type { GlobalVariable } from '../types';

export default function Variables() {
  const [vars, setVars] = useState<GlobalVariable[]>([]);
  const [dirty, setDirty] = useState(false);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const toast = useToast();
  const { user } = useAuth();
  const perms = permsFor(user?.role, user?.isAdmin);

  useEffect(() => {
    api.get<GlobalVariable[]>('/api/variables').then(setVars).catch((e) => toast(e.message, 'error'));
  }, []);

  const update = (i: number, patch: Partial<GlobalVariable>) => {
    setVars((v) => v.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setDirty(true);
  };

  const add = () => {
    setVars((v) => [...v, { key: '', value: '', secret: false }]);
    setDirty(true);
  };

  const remove = (i: number) => {
    setVars((v) => v.filter((_, j) => j !== i));
    setDirty(true);
  };

  const save = async () => {
    const bad = vars.find((v) => !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(v.key));
    if (bad !== undefined) {
      toast(`Invalid variable name: "${bad.key || '(empty)'}" — start with a letter/underscore, then letters, digits, _ . -`, 'error');
      return;
    }
    const keys = new Set<string>();
    for (const v of vars) {
      if (keys.has(v.key)) { toast(`Duplicate variable name: ${v.key}`, 'error'); return; }
      keys.add(v.key);
    }
    try {
      const saved = await api.put<GlobalVariable[]>('/api/variables', vars);
      setVars(saved);
      setDirty(false);
      toast('Global variables saved');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div>
      <div className="row mb">
        <h1 className="grow" style={{ margin: 0 }}>Global variables</h1>
        {perms.canCreate && <button className="btn" onClick={add}>+ Add variable</button>}
        {perms.canCreate && <button className="btn primary" disabled={!dirty} onClick={() => void save()}>Save</button>}
        {!perms.canCreate && <span className="muted" style={{ fontSize: 12 }}>Read-only</span>}
      </div>
      <p className="muted">
        Available to every suite as <span className="mono">{'{{variableName}}'}</span>. Suite variables with the same name take precedence.
        Captures with scope “global” write here automatically during runs.
      </p>

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
          {vars.map((v, i) => (
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
          {vars.length === 0 && <tr><td colSpan={4} className="muted">No global variables yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
