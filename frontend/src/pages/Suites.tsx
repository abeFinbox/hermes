import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Info } from '../legends';
import { Modal, useToast, Confirm } from '../ui';
import { useAuth } from '../App';
import { permsFor } from '../perms';
import type { Suite, SuiteListItem } from '../types';

export default function Suites() {
  const [items, setItems] = useState<SuiteListItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<SuiteListItem | null>(null);
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const perms = permsFor(user?.role, user?.isAdmin);

  const load = () => api.get<SuiteListItem[]>('/api/suites').then(setItems).catch((e) => toast(e.message, 'error'));
  useEffect(() => { void load(); }, []);

  const remove = async (id: string) => {
    await api.del(`/api/suites/${id}`);
    setDeleting(null);
    void load();
  };

  const duplicate = async (id: string) => {
    const s = await api.post<Suite>(`/api/suites/${id}/duplicate`);
    toast(`Duplicated as "${s.name}"`);
    void load();
  };

  const exportSuite = async (s: SuiteListItem) => {
    try {
      const collection = await api.get<object>(`/api/suites/${s.id}/export`);
      const blob = new Blob([JSON.stringify(collection, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${s.name.replace(/[^\w.-]+/g, '-')}.postman_collection.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported "${s.name}" as a Postman collection`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div>
      <div className="row wrap mb">
        <h1 className="grow" style={{ margin: 0 }}>Test suites</h1>
        {perms.canCreate && <button className="btn primary" onClick={() => setCreating(true)}>New suite from scratch</button>}
        <Info k="suites.new" />
      </div>

      {items.length === 0 ? (
        <div className="card muted">No suites yet. Import a collection or create a suite from scratch.</div>
      ) : (
        <table className="list">
          <thead><tr><th>Name</th><th>Steps</th><th>Origin</th><th>Updated</th><th style={{ width: 260 }}></th></tr></thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/suites/${s.id}`}><b>{s.name}</b></Link><div className="muted">{s.description}</div></td>
                <td>{s.stepCount}</td>
                <td className="muted">{s.collectionId ? 'imported' : 'from scratch'}</td>
                <td className="muted">{new Date(s.updatedAt).toLocaleString()}</td>
                <td>
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn small" onClick={() => navigate(`/suites/${s.id}`)}>{perms.canCreate ? 'Edit' : 'View'}</button>
                    {perms.canCreate && <button className="btn small" onClick={() => void duplicate(s.id)}>Duplicate</button>}
                    <button className="btn small" title="Download as a Postman collection v2.1 (re-importable here or in Postman)"
                      onClick={() => void exportSuite(s)}>Export</button>
                    <Info k="suites.export" />
                    <button className="btn small" onClick={() => navigate(`/runs?suiteId=${s.id}`)}>Runs</button>
                    {perms.canDelete && <button className="btn small danger" onClick={() => setDeleting(s)}>Delete</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {creating && <CreateModal onClose={() => setCreating(false)} />}
      {deleting && (
        <Confirm
          message={`Delete suite "${deleting.name}" and lose its steps, variables and settings? Run history is kept.`}
          onYes={() => void remove(deleting.id)}
          onNo={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function CreateModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const create = async () => {
    try {
      const s = await api.post<Suite>('/api/suites', { name, description });
      navigate(`/suites/${s.id}`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <Modal title="New suite from scratch" onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Payments happy path" />
      </label>
      <label className="field">
        <span>Description (optional)</span>
        <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {error && <div className="error-text mb">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>Create & open editor</button>
      </div>
    </Modal>
  );
}
