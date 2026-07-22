import { useEffect, useRef, useState } from 'react';
import { api, backendPath } from '../api';
import { Info } from '../legends';
import { useToast } from '../ui';
import { useAuth } from '../App';
import { permsFor } from '../perms';
import type { StoredFile } from '../types';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function Files() {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { user } = useAuth();
  const perms = permsFor(user?.role, user?.isAdmin);

  const load = () => api.get<StoredFile[]>('/api/files').then(setFiles).catch((e) => toast(e.message, 'error'));
  useEffect(() => { void load(); }, []);

  const uploadFiles = async (list: FileList | null) => {
    if (!list || !list.length) return;
    const form = new FormData();
    for (const f of Array.from(list)) form.append('files', f);
    setBusy(true);
    try {
      const created = await api.upload<StoredFile[]>('/api/files', form);
      toast(`Uploaded ${created.length} file${created.length === 1 ? '' : 's'}`);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async (f: StoredFile) => {
    if (!confirm(`Delete "${f.originalName}"? Requests referencing it will need a new file attached.`)) return;
    try {
      await api.del(`/api/files/${f.id}`);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div>
      <div className="row mb">
        <h1 className="grow" style={{ margin: 0 }}>Files<Info k="files.store" /></h1>
        {perms.canCreate && (
          <button className="btn primary" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? 'Uploading…' : '+ Upload files'}
          </button>
        )}
        <input ref={inputRef} type="file" multiple hidden onChange={(e) => void uploadFiles(e.target.files)} />
      </div>
      <p className="muted">
        A shared store for files you attach to requests. Upload once here, then reference a file from any request's{' '}
        <span className="mono">form-data</span> body (body mode → <b>form-data</b> → a <b>file</b> field). Files live on the server
        (in <span className="mono">DATA_DIR/files</span>), not inside suites, so they're reusable and stay out of exports.
      </p>

      {perms.canCreate && (
        <div
          className={`dropzone${dragOver ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void uploadFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
        >
          Drag &amp; drop files here, or click to choose. Up to 25 MB each.
        </div>
      )}

      <table className="list mt">
        <thead>
          <tr>
            <th>Name</th>
            <th style={{ width: 160 }}>Type</th>
            <th style={{ width: 90 }}>Size</th>
            <th style={{ width: 170 }}>Uploaded</th>
            <th style={{ width: 150 }}></th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.id}>
              <td className="mono">{f.originalName}</td>
              <td className="muted">{f.mime || '—'}</td>
              <td>{formatBytes(f.size)}</td>
              <td className="muted">{new Date(f.createdAt).toLocaleString()}</td>
              <td>
                <div className="row">
                  <a className="btn small" href={backendPath(`/api/files/${f.id}/download`)}>⬇ Download</a>
                  {perms.canDelete && <button className="btn small danger" onClick={() => void remove(f)}>Delete</button>}
                </div>
              </td>
            </tr>
          ))}
          {files.length === 0 && <tr><td colSpan={5} className="muted">No files yet — upload one to attach it to a request.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
