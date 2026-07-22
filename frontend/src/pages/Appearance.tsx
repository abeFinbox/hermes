import { useRef, useState } from 'react';
import { Info } from '../legends';
import { useToast, Confirm } from '../ui';
import { PRESETS, SYSTEM, TOKEN_DEFS, isTheme, useTheme, type Theme } from '../themes';

export default function Appearance() {
  const { selection, setSelection, customThemes, deleteCustom, saveCustom, setPreview } = useTheme();
  const [editing, setEditing] = useState<Theme | null>(null);
  const [deleting, setDeleting] = useState<Theme | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const startNew = (base: Theme) => {
    const copy: Theme = JSON.parse(JSON.stringify(base));
    copy.id = `custom-${crypto.randomUUID().slice(0, 8)}`;
    copy.name = `${base.name} (custom)`;
    setEditing(copy);
    setPreview(copy);
  };

  const startEdit = (theme: Theme) => {
    const copy: Theme = JSON.parse(JSON.stringify(theme));
    setEditing(copy);
    setPreview(copy);
  };

  const exportTheme = (theme: Theme) => {
    const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `theme-${theme.name.replace(/\W+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importTheme = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!isTheme(parsed)) throw new Error('not a valid theme file');
      parsed.id = `custom-${crypto.randomUUID().slice(0, 8)}`; // never clobber an existing theme
      saveCustom(parsed);
      setSelection(parsed.id);
      toast(`Theme "${parsed.name}" imported and applied`);
    } catch (e: any) {
      toast(`Import failed: ${e.message}`, 'error');
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  return (
    <div>
      <div className="row wrap mb">
        <h1 className="grow" style={{ margin: 0 }}>Appearance<Info k="nav.appearance" /></h1>
        <input ref={importRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
          onChange={(e) => void importTheme(e.target.files?.[0])} />
        <button className="btn" onClick={() => importRef.current?.click()}>⬆ Import theme JSON</button>
        <Info k="appearance.import" />
      </div>

      <h2>Mode<Info k="appearance.mode" /></h2>
      <div className="theme-grid mb">
        <button className={`theme-card ${selection === SYSTEM ? 'selected' : ''}`} onClick={() => setSelection(SYSTEM)}>
          <span className="theme-name">System</span>
          <span className="muted" style={{ fontSize: 11 }}>follows your OS light/dark setting</span>
          <span className="swatches">
            <span className="swatch half-light" /><span className="swatch half-dark" />
          </span>
        </button>
        {PRESETS.map((th) => <ThemeCard key={th.id} theme={th} selected={selection === th.id}
          onSelect={() => setSelection(th.id)} onCustomize={() => startNew(th)} />)}
      </div>

      <h2>Custom themes<Info k="appearance.custom" /></h2>
      {customThemes.length === 0 && (
        <p className="muted">None yet — click “customize” on any preset above to use it as a starting point.
          Custom themes are stored in this browser.</p>
      )}
      <div className="theme-grid mb">
        {customThemes.map((th) => (
          <ThemeCard key={th.id} theme={th} selected={selection === th.id}
            onSelect={() => setSelection(th.id)} onEdit={() => startEdit(th)}
            onExport={() => exportTheme(th)} onDelete={() => setDeleting(th)} />
        ))}
      </div>

      {editing && (
        <ThemeBuilder
          theme={editing}
          onChange={(next) => { setEditing(next); setPreview(next); }}
          onSave={() => {
            saveCustom(editing);
            setSelection(editing.id);
            setPreview(null);
            setEditing(null);
            toast(`Theme "${editing.name}" saved and applied`);
          }}
          onCancel={() => { setPreview(null); setEditing(null); }}
        />
      )}

      {deleting && (
        <Confirm message={`Delete custom theme "${deleting.name}"?`}
          onYes={() => { deleteCustom(deleting.id); setDeleting(null); }} onNo={() => setDeleting(null)} />
      )}
    </div>
  );
}

function ThemeCard({ theme, selected, onSelect, onCustomize, onEdit, onExport, onDelete }: {
  theme: Theme; selected: boolean; onSelect: () => void;
  onCustomize?: () => void; onEdit?: () => void; onExport?: () => void; onDelete?: () => void;
}) {
  return (
    <div className={`theme-card ${selected ? 'selected' : ''}`} onClick={onSelect} role="button" tabIndex={0}>
      <span className="theme-name">{theme.name}{selected && <span className="muted"> ✓ active</span>}</span>
      <span className="swatches">
        {(['bg', 'surface', 'primary', 'success', 'danger', 'text'] as const).map((k) => (
          <span key={k} className="swatch" title={k} style={{ background: theme.tokens[k] }} />
        ))}
      </span>
      <span className="row" style={{ gap: 6 }}>
        {onCustomize && <button className="btn small" onClick={(e) => { e.stopPropagation(); onCustomize(); }}>customize</button>}
        {onEdit && <button className="btn small" onClick={(e) => { e.stopPropagation(); onEdit(); }}>edit</button>}
        {onExport && <button className="btn small" onClick={(e) => { e.stopPropagation(); onExport(); }}>export</button>}
        {onDelete && <button className="btn small danger" onClick={(e) => { e.stopPropagation(); onDelete(); }}>delete</button>}
      </span>
    </div>
  );
}

function ThemeBuilder({ theme, onChange, onSave, onCancel }: {
  theme: Theme; onChange: (t: Theme) => void; onSave: () => void; onCancel: () => void;
}) {
  const setToken = (key: string, value: string) => onChange({ ...theme, tokens: { ...theme.tokens, [key]: value } });

  return (
    <div className="card mt" style={{ maxWidth: 720 }}>
      <h2>Theme builder — changes preview live<Info k="appearance.builder" /></h2>
      <div className="row wrap mb">
        <label className="field grow" style={{ marginBottom: 0 }}>
          <span>Theme name</span>
          <input type="text" value={theme.name} onChange={(e) => onChange({ ...theme, name: e.target.value })} />
        </label>
        <label className="field" style={{ width: 130, marginBottom: 0 }}>
          <span>Corner radius: {theme.radius}px</span>
          <input type="range" min={0} max={20} value={theme.radius}
            onChange={(e) => onChange({ ...theme, radius: Number(e.target.value) })} />
        </label>
        <label className="row" style={{ gap: 6, cursor: 'pointer' }}
          title="Marks the theme as dark so native controls (scrollbars, inputs) render in dark mode">
          <input type="checkbox" checked={theme.dark} onChange={(e) => onChange({ ...theme, dark: e.target.checked })} />
          dark theme
        </label>
      </div>

      <div className="token-grid">
        {TOKEN_DEFS.map((def) => (
          <label key={def.key} className="token-row">
            <input type="color" value={normalizeHex(theme.tokens[def.key])} onChange={(e) => setToken(def.key, e.target.value)} />
            <span className="grow">{def.label}</span>
            <input className="mono" style={{ width: 90 }} type="text" value={theme.tokens[def.key]}
              onChange={(e) => setToken(def.key, e.target.value)} />
          </label>
        ))}
      </div>

      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onCancel}>Cancel (revert preview)</button>
        <button className="btn primary" disabled={!theme.name.trim()} onClick={onSave}>Save & apply</button>
      </div>
    </div>
  );
}

/** <input type="color"> only accepts #rrggbb. */
function normalizeHex(v: string): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return '#000000';
  const h = m[1];
  return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
}
