import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Info } from '../legends';
import { useToast } from '../ui';

interface DocMeta { key: string; title: string }
interface DocContent { key: string; title: string; markdown: string }

export default function Docs() {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [active, setActive] = useState<string>('readme');
  const [content, setContent] = useState<DocContent | null>(null);
  const toast = useToast();

  useEffect(() => {
    api.get<DocMeta[]>('/api/docs').then(setDocs).catch((e) => toast(e.message, 'error'));
  }, []);

  useEffect(() => {
    setContent(null);
    api.get<DocContent>(`/api/docs/${active}`).then(setContent).catch((e) => toast(e.message, 'error'));
  }, [active]);

  const download = () => {
    if (!content) return;
    const blob = new Blob([content.markdown], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${content.key}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      <div className="row wrap mb">
        <h1 className="grow" style={{ margin: 0 }}>Documentation<Info k="nav.docs" /></h1>
        <button className="btn" disabled={!content} onClick={download}>⬇ Download .md</button>
      </div>

      <div className="tabs">
        {docs.map((d) => (
          <button key={d.key} className={active === d.key ? 'active' : ''} onClick={() => setActive(d.key)}>{d.title}</button>
        ))}
      </div>

      <div className="card markdown">
        {content ? <Markdown source={content.markdown} /> : <span className="muted">Loading…</span>}
      </div>
    </div>
  );
}

/* ------------ minimal, safe markdown renderer (no dangerouslySetInnerHTML) ------------ */

function Inline({ text }: { text: string }): ReactNode {
  // order matters: code first (so its contents aren't further parsed), then links, then bold/italic
  const nodes: ReactNode[] = [];
  let rest = text;
  let k = 0;
  const re = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)/;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) { nodes.push(rest); break; }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      nodes.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('[')) {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      nodes.push(<a key={k++} href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>);
    } else if (tok.startsWith('**')) {
      nodes.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    }
    rest = rest.slice(m.index + tok.length);
  }
  return <>{nodes}</>;
}

function splitRow(line: string): string[] {
  return line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

function Markdown({ source }: { source: string }): ReactNode {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      blocks.push(<pre className="body-view" key={key++}>{buf.join('\n')}</pre>);
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const Tag = (`h${Math.min(level, 4)}`) as 'h1' | 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={key++}><Inline text={h[2]} /></Tag>);
      i++;
      continue;
    }

    // horizontal rule
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push(<hr key={key++} />);
      i++;
      continue;
    }

    // table: header row followed by a separator row of ---
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      blocks.push(
        <div className="table-scroll" key={key++}>
          <table className="list">
            <thead><tr>{header.map((c, j) => <th key={j}><Inline text={c} /></th>)}</tr></thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci}><Inline text={c} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // lists (unordered or ordered)
    const isUl = /^\s*[-*]\s+/.test(line);
    const isOl = /^\s*\d+\.\s+/.test(line);
    if (isUl || isOl) {
      const items: string[] = [];
      const pat = isUl ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/;
      while (i < lines.length && (isUl ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/).test(lines[i])) {
        items.push(lines[i].replace(pat, ''));
        i++;
      }
      const List = isOl ? 'ol' : 'ul';
      blocks.push(<List key={key++}>{items.map((it, j) => <li key={j}><Inline text={it} /></li>)}</List>);
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={key++}><Inline text={buf.join(' ')} /></blockquote>);
      continue;
    }

    // blank line
    if (!line.trim()) { i++; continue; }

    // paragraph (gather consecutive non-structural lines)
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,6}\s|```|>\s?|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]))
    ) {
      buf.push(lines[i++]);
    }
    blocks.push(<p key={key++}><Inline text={buf.join(' ')} /></p>);
  }

  return <Fragment>{blocks}</Fragment>;
}
