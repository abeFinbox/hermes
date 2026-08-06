import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Info } from '../legends';
import { Modal, useToast, Confirm } from '../ui';
import { useAuth } from '../App';
import { permsFor } from '../perms';
import type { BundleImportResult, Suite, SuiteListItem } from '../types';

export default function Suites() {
  const [items, setItems] = useState<SuiteListItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [migrating, setMigrating] = useState<SuiteListItem | null>(null);
  const [importingBundle, setImportingBundle] = useState(false);
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
        {perms.canCreate && <button className="btn" onClick={() => setImportingBundle(true)}>Import bundle</button>}
        {perms.canCreate && <Info k="suites.importBundle" />}
        {perms.canCreate && <button className="btn primary" onClick={() => setCreating(true)}>New suite from scratch</button>}
        <Info k="suites.new" />
      </div>

      {items.length === 0 ? (
        <div className="card muted">No suites yet. Import a collection, import a bundle from another Hermes instance, or create a suite from scratch.</div>
      ) : (
        <table className="list">
          <thead><tr><th>Name</th><th>Steps</th><th>Origin</th><th>Updated</th><th style={{ width: 340 }}></th></tr></thead>
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
                    <button className="btn small" title="Download a lossless Hermes bundle for moving this suite to another instance"
                      onClick={() => setMigrating(s)}>Migrate</button>
                    <Info k="suites.bundle" />
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
      {migrating && <MigrateModal suite={migrating} isAdmin={perms.role === 'admin'} onClose={() => setMigrating(null)} />}
      {importingBundle && (
        <ImportBundleModal onClose={() => setImportingBundle(false)} onDone={() => { setImportingBundle(false); void load(); }} />
      )}
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

/**
 * Migrate = download a native bundle. The Postman export next to it cannot
 * carry polling, suite settings, sandbox scripts or file bytes, so moving a
 * suite between instances goes through a bundle instead.
 */
function MigrateModal({ suite, isAdmin, onClose }: { suite: SuiteListItem; isAdmin: boolean; onClose: () => void }) {
  const [includeFiles, setIncludeFiles] = useState(true);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const download = async () => {
    setBusy(true);
    setError('');
    try {
      // download=0 returns { bundle, warnings } so warnings can be shown here
      // instead of being buried in a response header on a file download
      const res = await api.get<{ bundle: unknown; warnings: string[] }>(
        `/api/suites/${suite.id}/bundle?download=0&includeFiles=${includeFiles ? '1' : '0'}&includeSecrets=${includeSecrets ? '1' : '0'}`,
      );
      const blob = new Blob([JSON.stringify(res.bundle)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${suite.name.replace(/[^\w.-]+/g, '-')}.hermes-bundle.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setWarnings(res.warnings);
      if (!res.warnings.length) toast(`Bundled "${suite.name}" — import it on the target instance`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Migrate "${suite.name}"`} onClose={onClose}>
      <p className="muted">
        Downloads a <b>.hermes-bundle.json</b> — a lossless snapshot including polling, suite settings, sandbox scripts,
        visual assertions and attached files. Import it on the target instance from <b>Suites → Import bundle</b>.
      </p>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)} />
        Embed attached files (form-data file parts)
      </label>
      <label className="row" style={{ cursor: isAdmin ? 'pointer' : 'not-allowed', opacity: isAdmin ? 1 : 0.5 }}>
        <input type="checkbox" checked={includeSecrets} disabled={!isAdmin}
          onChange={(e) => setIncludeSecrets(e.target.checked)} />
        Include secret values in plaintext {isAdmin ? '' : '(admin only)'}
        <Info k="suites.bundleSecrets" />
      </label>
      {includeSecrets && (
        <div className="error-text mt">
          The downloaded file will contain secret values in plaintext. Treat it as a credential.
        </div>
      )}
      {warnings && warnings.length > 0 && (
        <div className="card mt">
          <b>Downloaded, with notes:</b>
          <ul style={{ margin: '6px 0 0 18px' }}>{warnings.map((w, i) => <li key={i} className="muted">{w}</li>)}</ul>
        </div>
      )}
      {error && <div className="error-text mt">{error}</div>}
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>{warnings ? 'Done' : 'Cancel'}</button>
        <button className="btn primary" disabled={busy} onClick={() => void download()}>
          {busy ? 'Bundling…' : warnings ? 'Download again' : 'Download bundle'}
        </button>
      </div>
    </Modal>
  );
}

function ImportBundleModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [name, setName] = useState('');
  const [includeGlobals, setIncludeGlobals] = useState(true);
  const [overwriteGlobals, setOverwriteGlobals] = useState(false);
  const [result, setResult] = useState<BundleImportResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const navigate = useNavigate();

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name);
    setText(await f.text());
  };

  const doImport = async () => {
    setBusy(true);
    setError('');
    let bundle: unknown;
    try {
      bundle = JSON.parse(text);
    } catch {
      setError('That is not valid JSON.');
      setBusy(false);
      return;
    }
    try {
      const res = await api.post<BundleImportResult>('/api/suites/import-bundle', {
        bundle,
        name: name.trim() || undefined,
        includeGlobals,
        overwriteGlobals,
      });
      setResult(res);
      onDone();
      if (!res.warnings.length) toast(`Imported "${res.name}" (${res.stepCount} steps)`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal title={`Imported "${result.name}"`} onClose={onClose}>
        <p className="muted">
          {result.stepCount} step(s), {Object.keys(result.fileMap).length} file(s) re-uploaded here
          {result.importedGlobals.length > 0 && `, globals added: ${result.importedGlobals.join(', ')}`}
          {result.skippedGlobals.length > 0 && `, globals kept as they were here: ${result.skippedGlobals.join(', ')}`}.
        </p>
        {result.secretsNeeded.length > 0 && (
          <div className="error-text mb">
            Fill these secret values before running: <b>{result.secretsNeeded.join(', ')}</b>
          </div>
        )}
        {result.warnings.length > 0 && (
          <div className="card mb">
            <b>Notes:</b>
            <ul style={{ margin: '6px 0 0 18px' }}>{result.warnings.map((w, i) => <li key={i} className="muted">{w}</li>)}</ul>
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={() => navigate(`/suites/${result.suiteId}`)}>Open suite & run</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Import Hermes bundle" onClose={onClose}>
      <p className="muted">
        Upload a <b>.hermes-bundle.json</b> produced by <b>Migrate</b> on another instance. A new suite is created —
        nothing here is overwritten. For Postman collections use <b>Collections → Import Postman collection</b> instead.
      </p>
      <div className="row mb">
        <input ref={fileRef} type="file" accept=".json,application/json" onChange={(e) => void onFile(e.target.files?.[0])} />
        {fileName && <span className="muted mono">{fileName}</span>}
      </div>
      <textarea className="code" rows={8} placeholder='{"hermesBundle": 1, "suite": {...}}' value={text} onChange={(e) => setText(e.target.value)} />
      <label className="field mt">
        <span>Suite name on this instance (optional)</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="defaults to the bundle's name" />
      </label>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={includeGlobals} onChange={(e) => setIncludeGlobals(e.target.checked)} />
        Also import the global variables the suite references
        <Info k="suites.bundleGlobals" />
      </label>
      <label className="row" style={{ cursor: includeGlobals ? 'pointer' : 'not-allowed', opacity: includeGlobals ? 1 : 0.5 }}>
        <input type="checkbox" checked={overwriteGlobals} disabled={!includeGlobals}
          onChange={(e) => setOverwriteGlobals(e.target.checked)} />
        Overwrite globals that already exist here
      </label>
      {error && <div className="error-text mt">{error}</div>}
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!text.trim() || busy} onClick={() => void doImport()}>
          {busy ? 'Importing…' : 'Import bundle'}
        </button>
      </div>
    </Modal>
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
