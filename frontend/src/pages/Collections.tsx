import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Info } from '../legends';
import { Modal, useToast, Confirm } from '../ui';
import { useAuth } from '../App';
import { permsFor } from '../perms';
import type { CollectionListItem, TreeNode } from '../types';

export default function Collections() {
  const [items, setItems] = useState<CollectionListItem[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [viewing, setViewing] = useState<{ name: string; tree: TreeNode[] } | null>(null);
  const [deleting, setDeleting] = useState<CollectionListItem | null>(null);
  const toast = useToast();
  const { user } = useAuth();
  const perms = permsFor(user?.role, user?.isAdmin);

  const load = () => api.get<CollectionListItem[]>('/api/collections').then(setItems).catch((e) => toast(e.message, 'error'));
  useEffect(() => { void load(); }, []);

  const view = async (id: string) => {
    const c = await api.get<{ name: string; tree: TreeNode[] }>(`/api/collections/${id}`);
    setViewing(c);
  };

  const remove = async (id: string) => {
    await api.del(`/api/collections/${id}`);
    setDeleting(null);
    toast('Collection deleted (its suites keep their own copy of the steps)');
    void load();
  };

  return (
    <div>
      <div className="row wrap mb">
        <h1 className="grow" style={{ margin: 0 }}>Collections</h1>
        {perms.canCreate && <button className="btn primary" onClick={() => setImportOpen(true)}>Import Postman collection</button>}
        <Info k="collections.import" />
      </div>

      {items.length === 0 ? (
        <div className="card muted">
          No collections yet. Import a Postman v2.0/v2.1 export to get started — or create a suite from scratch on the Suites page.
        </div>
      ) : (
        <table className="list">
          <thead><tr><th>Name</th><th>Imported</th><th style={{ width: 220 }}></th></tr></thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="muted">{new Date(c.createdAt).toLocaleString()}</td>
                <td>
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn small" onClick={() => void view(c.id)}>View tree</button>
                    {perms.canDelete && <button className="btn small danger" onClick={() => setDeleting(c)}>Delete</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); void load(); }} />}
      {viewing && (
        <Modal title={`Collection: ${viewing.name}`} onClose={() => setViewing(null)}>
          <div className="tree"><Tree nodes={viewing.tree} /></div>
        </Modal>
      )}
      {deleting && (
        <Confirm
          message={`Delete collection "${deleting.name}"? Suites created from it are NOT deleted — they own their own copy of the steps.`}
          onYes={() => void remove(deleting.id)}
          onNo={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function Tree({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ul>
      {nodes.map((n, i) => (
        <li key={i}>
          {n.type === 'folder' ? (
            <details open>
              <summary className="folder-name">📁 {n.name}</summary>
              {n.children && <Tree nodes={n.children} />}
            </details>
          ) : (
            <span>
              <span className={`chip ${n.method}`}>{n.method}</span> {n.name} <span className="muted mono">{n.url}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [createSuite, setCreateSuite] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const navigate = useNavigate();

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
  };

  const doImport = async () => {
    setBusy(true);
    setError('');
    try {
      JSON.parse(text); // fail fast with a clear message
    } catch {
      setError('That is not valid JSON.');
      setBusy(false);
      return;
    }
    try {
      const res = await api.post<{ id: string; name: string; suiteId: string | null; stepCount: number }>(
        '/api/collections/import',
        { json: text, createSuite },
      );
      toast(`Imported "${res.name}" (${res.stepCount} requests)`);
      onDone();
      if (res.suiteId) navigate(`/suites/${res.suiteId}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Import Postman collection" onClose={onClose}>
      <p className="muted">Export from Postman as <b>Collection v2.1</b> (File → Export), then upload or paste the JSON here.</p>
      <div className="row mb">
        <input ref={fileRef} type="file" accept=".json,application/json" onChange={(e) => void onFile(e.target.files?.[0])} />
      </div>
      <textarea className="code" rows={12} placeholder='{"info": {...}, "item": [...]}' value={text} onChange={(e) => setText(e.target.value)} />
      <label className="row mt" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={createSuite} onChange={(e) => setCreateSuite(e.target.checked)} />
        Also create an editable test suite from this collection
        <Info k="collections.createSuite" />
      </label>
      {error && <div className="error-text mt">{error}</div>}
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!text.trim() || busy} onClick={() => void doImport()}>
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
    </Modal>
  );
}
