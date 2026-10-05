import { useEffect, useMemo, useRef, useState } from 'react';
import type { HeraLogLine } from '../types';

/**
 * k6 output viewer. Same toolbar shape and CSS classes as BodyViewer, so the two
 * read as one idiom and no new styles are needed — the differences are what a
 * live, growing log actually needs:
 *
 *   - Follow: pins the view to the newest line while output is arriving, and
 *     switches itself OFF the moment the reader scrolls up. Without that, every
 *     poll yanks them back down mid-read.
 *   - Errors only: k6 emits one warning per failed request, so a busy run buries
 *     the HERA_DIAG lines that explain the failure.
 */
export default function LogViewer({
  lines,
  live,
  dropped,
  notice,
}: {
  lines: HeraLogLine[];
  live: boolean;
  dropped: number;
  notice?: string;
}) {
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const pre = useRef<HTMLPreElement | null>(null);

  const shown = useMemo(
    () => (errorsOnly ? lines.filter((l) => l.level === 'error' || l.level === 'warning') : lines),
    [lines, errorsOnly],
  );
  const text = useMemo(() => shown.map((l) => l.msg).join('\n'), [shown]);

  useEffect(() => {
    if (!follow || !live) return;
    const el = pre.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, follow, live]);

  const onScroll = () => {
    const el = pre.current;
    if (!el || !follow) return;
    // 24px of slack: a browser's fractional scrollHeight would otherwise read as
    // "scrolled up" on its own and turn Follow off without the user touching it.
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 24) setFollow(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context) — text is still selectable */
    }
  };

  return (
    <div className="body-viewer">
      <div className="body-viewer-toolbar">
        <button className="btn small" onClick={copy} title="Copy the output to the clipboard">
          {copied ? '✓ Copied' : '⧉ Copy'}
        </button>
        <button className="btn small" onClick={() => setWrap((w) => !w)} title="Toggle line wrapping">
          {wrap ? '↵ No wrap' : '↵ Wrap'}
        </button>
        <button
          className="btn small"
          onClick={() => setErrorsOnly((e) => !e)}
          title="Show only warnings and errors"
        >
          {errorsOnly ? '⚠ All lines' : '⚠ Errors only'}
        </button>
        {live && (
          <button
            className="btn small"
            onClick={() => setFollow((f) => !f)}
            title="Keep the newest line in view as output arrives"
          >
            {follow ? '⤓ Following' : '⤓ Follow'}
          </button>
        )}
        {dropped > 0 && (
          <span className="muted" title="Raise HERA_LOG_LINES to keep more">
            {dropped.toLocaleString()} earlier line{dropped === 1 ? '' : 's'} dropped
          </span>
        )}
        {notice && <span className="muted">{notice}</span>}
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {shown.length.toLocaleString()} line{shown.length === 1 ? '' : 's'}
        </span>
      </div>
      <pre ref={pre} onScroll={onScroll} className={`body-view large${wrap ? '' : ' nowrap'}`}>
        {text}
      </pre>
    </div>
  );
}
