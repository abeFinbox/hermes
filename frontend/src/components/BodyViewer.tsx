import { useMemo, useState } from 'react';

/**
 * Response-body viewer with a toolbar: copy, beautify (pretty-print JSON) and
 * wrap toggles. The panel is tall and resizable (drag the bottom edge) so long
 * bodies aren't squeezed into a few lines. Shared by the run detail, the
 * single-step Send result and each poll attempt.
 */
export default function BodyViewer({ body, truncated }: { body: string; truncated?: boolean }) {
  const isJson = useMemo(() => {
    const t = (body || '').trim();
    if (!t || !/^[{[]/.test(t)) return false;
    try { JSON.parse(t); return true; } catch { return false; }
  }, [body]);

  const [beautify, setBeautify] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);

  const shown = useMemo(() => {
    if (beautify && isJson) {
      try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
    }
    return body;
  }, [body, beautify, isJson]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context) — text is still selectable */
    }
  };

  return (
    <div className="body-viewer">
      <div className="body-viewer-toolbar">
        <button className="btn small" onClick={copy} title="Copy the body to the clipboard">{copied ? '✓ Copied' : '⧉ Copy'}</button>
        {isJson && (
          <button className="btn small" onClick={() => setBeautify((b) => !b)} title="Pretty-print / raw JSON">
            {beautify ? '{ } Raw' : '{ } Beautify'}
          </button>
        )}
        <button className="btn small" onClick={() => setWrap((w) => !w)} title="Toggle line wrapping">
          {wrap ? '↵ No wrap' : '↵ Wrap'}
        </button>
        {truncated && <span className="muted">stored preview truncated</span>}
        <span className="muted" style={{ marginLeft: 'auto' }}>{(body?.length ?? 0).toLocaleString()} chars</span>
      </div>
      <pre className={`body-view large${wrap ? '' : ' nowrap'}`}>{shown}</pre>
    </div>
  );
}
