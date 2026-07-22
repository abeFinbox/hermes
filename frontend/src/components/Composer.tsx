import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Info } from '../legends';
import { useToast } from '../ui';
import { newId, type Step, type Suite, type SuiteVariable } from '../types';
import { tokensInStep } from './VarChips';

/**
 * Suite Composer: a small draggable floating box, available only in the suite
 * editor and only while its toggle is on. Collect requests from any suite
 * (＋ button or drag a step row onto the box), reorder them, then create a
 * brand-new suite from the list. The basket survives navigation between
 * suites (localStorage) so you can mix requests from several suites.
 */

export interface ComposerItem {
  id: string;
  name: string;
  method: string;
  sourceSuite: string;
  step: Step;
  /** Source-suite variables this step references — carried into the new suite. */
  vars: SuiteVariable[];
}

const ITEMS_KEY = 'ats.composer.items';
const ON_KEY = 'ats.composer.on';
const POS_KEY = 'ats.composer.pos';

export function loadComposerItems(): ComposerItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ITEMS_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveComposerItems(items: ComposerItem[]) {
  localStorage.setItem(ITEMS_KEY, JSON.stringify(items));
}

export function loadComposerOn(): boolean {
  return localStorage.getItem(ON_KEY) === '1';
}

export function saveComposerOn(on: boolean) {
  localStorage.setItem(ON_KEY, on ? '1' : '0');
}

export function makeComposerItem(step: Step, sourceSuite: string, suiteVars: SuiteVariable[]): ComposerItem {
  const copy: Step = JSON.parse(JSON.stringify(step));
  copy.id = newId(); // the new suite gets its own step identity
  const tokens = new Set(tokensInStep(step));
  const vars = suiteVars.filter((v) => tokens.has(v.key)).map((v) => ({ ...v }));
  return { id: newId(), name: step.name, method: step.request.method, sourceSuite, step: copy, vars };
}

export function ComposerBox({ items, onChange, onClose, onDropStep }: {
  items: ComposerItem[];
  onChange: (items: ComposerItem[]) => void;
  onClose: () => void;
  onDropStep: (stepIndex: number) => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (p && typeof p.x === 'number' && typeof p.y === 'number') return p;
    } catch { /* fall through */ }
    return { x: Math.max(12, window.innerWidth - 300), y: 90 };
  });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  }, [pos]);

  // drag the box by its header
  const onHeaderPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // don't drag from the ✕
    e.preventDefault();
    const offsetX = e.clientX - pos.x;
    const offsetY = e.clientY - pos.y;
    const move = (ev: PointerEvent) => {
      const w = boxRef.current?.offsetWidth ?? 280;
      setPos({
        x: Math.min(Math.max(0, ev.clientX - offsetX), window.innerWidth - w),
        y: Math.min(Math.max(0, ev.clientY - offsetY), window.innerHeight - 60),
      });
    };
    const up = () => window.removeEventListener('pointermove', move);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  const create = async () => {
    setBusy(true);
    try {
      const created = await api.post<Suite>('/api/suites', {
        name: name.trim(),
        description: `Composed from: ${[...new Set(items.map((x) => x.sourceSuite))].join(', ')}`,
      });
      // carry over the referenced source-suite variables (first suite wins on name clashes)
      const variables: SuiteVariable[] = [];
      for (const item of items) {
        for (const v of item.vars || []) {
          if (!variables.some((x) => x.key === v.key)) variables.push(v);
        }
      }
      const saved = await api.put<Suite>(`/api/suites/${created.id}`, { steps: items.map((x) => x.step), variables });
      onChange([]);
      setName('');
      toast(`Suite "${saved.name}" created with ${items.length} request${items.length === 1 ? '' : 's'}`);
      navigate(`/suites/${saved.id}`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={boxRef} className={`composer-box ${dragOver ? 'drag-over' : ''}`} style={{ left: pos.x, top: pos.y }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const idx = Number(e.dataTransfer.getData('text/step-index'));
        if (!Number.isNaN(idx)) onDropStep(idx);
      }}>
      <div className="composer-header" onPointerDown={onHeaderPointerDown} title="Drag to move">
        <span>🧺 Suite composer ({items.length})<Info k="composer.box" /></span>
        <button className="btn icon" title="Close (toggle stays available above)" onClick={onClose}>✕</button>
      </div>

      <div className="composer-body">
        {items.length === 0 ? (
          <div className="muted" style={{ padding: '8px 2px' }}>
            Empty — click ＋ on a step, or drag a step row and drop it here.
          </div>
        ) : (
          items.map((item, i) => (
            <div className="composer-item" key={item.id}>
              <span className={`chip ${item.method}`}>{item.method}</span>
              <span className="name" title={`from suite "${item.sourceSuite}"`}>
                {item.name}
                <span className="folder">{item.sourceSuite}</span>
              </span>
              <button className="btn icon" title="Move up" onClick={() => move(i, -1)}>↑</button>
              <button className="btn icon" title="Move down" onClick={() => move(i, 1)}>↓</button>
              <button className="btn icon danger" title="Remove" onClick={() => onChange(items.filter((x) => x.id !== item.id))}>✕</button>
            </div>
          ))
        )}

        <div className="row mt">
          <input className="grow" type="text" placeholder="New suite name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="row mt" style={{ justifyContent: 'space-between' }}>
          <button className="btn small" disabled={items.length === 0} onClick={() => onChange([])}>Clear</button>
          <button className="btn primary small" disabled={busy || items.length === 0 || !name.trim()} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create suite ➜'}
          </button>
        </div>
      </div>
    </div>
  );
}
