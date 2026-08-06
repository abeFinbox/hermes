import { useState } from 'react';
import { Info } from '../legends';

export default function CurlBlock({ curl }: { curl: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(curl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (e.g. insecure context) — the text is still selectable below */
    }
  };
  return (
    <div className="mb">
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>cURL<Info k="step.curl" /></h3>
        <button className="btn small" onClick={() => void copy()}>{copied ? '✓ Copied' : '⧉ Copy'}</button>
      </div>
      <pre className="body-view curl-view">{curl}</pre>
      <p className="muted" style={{ fontSize: 11 }}>Real resolved values, including any secrets — for local debugging only.</p>
    </div>
  );
}
