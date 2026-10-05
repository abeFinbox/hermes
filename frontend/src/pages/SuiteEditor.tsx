import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Info } from '../legends';
import { useToast, Confirm, Modal } from '../ui';
import { useAuth } from '../App';
import { permsFor } from '../perms';
import { parseCurl } from '../curl';
import { emptyStep, type Environment, type GlobalVariable, type Step, type StepRequest, type StepResult, type Suite } from '../types';
import { RequestTab, RequestUrlRow, ValidateTab, CaptureTab, PollTab } from '../components/StepTabs';
import ScriptBench from '../components/ScriptBench';
import PollAttempts from '../components/PollAttempts';
import BodyViewer from '../components/BodyViewer';
import CurlBlock from '../components/CurlBlock';
import KVEditor from '../components/KVEditor';
import {
  ComposerBox, loadComposerItems, saveComposerItems, loadComposerOn, saveComposerOn,
  makeComposerItem, type ComposerItem,
} from '../components/Composer';

type StepTab = 'request' | 'validate' | 'capture' | 'poll';
type SuiteTab = 'steps' | 'variables' | 'settings';

export default function SuiteEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const perms = permsFor(user?.role, user?.isAdmin);

  const [suite, setSuite] = useState<Suite | null>(null);
  const [globals, setGlobals] = useState<GlobalVariable[]>([]);
  const [envs, setEnvs] = useState<Environment[]>([]);
  // Environment for THIS editing session: seeded from the suite's default and
  // saved back with the suite, so Send / Run / Load test all agree on it.
  const [envId, setEnvId] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [stepTab, setStepTab] = useState<StepTab>('request');
  const [suiteTab, setSuiteTab] = useState<SuiteTab>('steps');
  const [dirty, setDirty] = useState(false);
  const [deletingStep, setDeletingStep] = useState<number | null>(null);
  const [importCurl, setImportCurl] = useState(false);
  const [cycles, setCycles] = useState(1);
  const [stopOnFailure, setStopOnFailure] = useState(false);
  const [running, setRunning] = useState(false);
  const [stepResults, setStepResults] = useState<Record<string, StepResult | 'running'>>({});
  const detailRef = useRef<HTMLDivElement>(null);
  const detailBodyRef = useRef<HTMLDivElement>(null);
  // Wiring for the ⌘/Ctrl+Enter handler below: what to send, what the bench
  // would run instead, and whether a dialog is currently up.
  const sendRef = useRef<(() => void) | null>(null);
  const benchRunRef = useRef<(() => void) | null>(null);
  const modalOpenRef = useRef(false);
  const setBenchRunnable = useCallback((run: (() => void) | null) => {
    benchRunRef.current = run;
  }, []);
  const [composerOn, setComposerOn] = useState(loadComposerOn);
  const [composerItems, setComposerItems] = useState<ComposerItem[]>(loadComposerItems);
  const [stepQuery, setStepQuery] = useState('');
  // Reorder-by-drag: the row being dragged, and the slot the pointer is over
  // (an insertion index, 0..steps.length, so "after the last step" is expressible).
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);

  const toggleComposer = (on: boolean) => {
    setComposerOn(on);
    saveComposerOn(on);
  };

  const changeComposerItems = (items: ComposerItem[]) => {
    setComposerItems(items);
    saveComposerItems(items);
  };

  const loadGlobals = useCallback(() => {
    api.get<GlobalVariable[]>('/api/variables').then(setGlobals).catch(() => {});
  }, []);

  useEffect(() => {
    api.get<Suite>(`/api/suites/${id}`)
      .then((s) => {
        setSuite(s);
        setCycles(s.settings.defaultCycles || 1);
        setStopOnFailure(s.settings.stopOnFailure);
        setEnvId(s.defaultEnvId ?? null);
      })
      .catch((e) => toast(e.message, 'error'));
    loadGlobals();
    api.get<Environment[]>('/api/environments').then(setEnvs).catch(() => {});
  }, [id]);

  // keep the detail panel in view when picking a step far down a long list, and
  // start the new step at its top rather than wherever the last one was scrolled
  useEffect(() => {
    detailRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (detailBodyRef.current) detailBodyRef.current.scrollTop = 0;
  }, [selected]);

  /**
   * ⌘/Ctrl + Enter — send the selected step from anywhere in the editor,
   * including from inside the URL box or the body textarea.
   *
   * Everything it needs is read through refs and the listener is installed once:
   * the handlers below are defined AFTER the `if (!suite)` early return, so they
   * cannot be effect dependencies without making the hook order conditional.
   *
   * When the script bench is open it claims the shortcut (see ScriptBench's
   * onRunnableChange) — running the bench you are looking at beats firing a real
   * request you did not ask for.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (modalOpenRef.current) return; // a dialog owns the keyboard
      const bench = benchRunRef.current;
      const send = sendRef.current;
      if (!bench && !send) return;
      e.preventDefault();
      (bench ?? send)!();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!suite) return <div className="muted">Loading…</div>;

  const patchSuite = (patch: Partial<Suite>) => {
    setSuite((s) => (s ? { ...s, ...patch } : s));
    setDirty(true);
  };

  const addToComposer = (i: number) => {
    const st = suite.steps[i];
    if (!st) return;
    setComposerItems((prev) => {
      const next = [...prev, makeComposerItem(st, suite.name, suite.variables)];
      saveComposerItems(next);
      return next;
    });
    toast(`"${st.name}" added to composer`);
  };

  const patchStep = (i: number, patch: Partial<Step>) => {
    patchSuite({ steps: suite.steps.map((st, j) => (j === i ? { ...st, ...patch } : st)) });
  };

  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= suite.steps.length) return;
    const steps = [...suite.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    patchSuite({ steps });
    setSelected(j);
  };

  /**
   * Drop a step into a new position. `slot` is an INSERTION index in the current
   * array (0..length), which is what makes "drop after the last step" sayable.
   *
   * Selection is re-derived from the step's id rather than arithmetic on the old
   * index: after a move the selected step must stay selected wherever it landed,
   * and every off-by-one here would silently select a neighbour.
   */
  const moveStepTo = (from: number, slot: number) => {
    if (from === slot || from + 1 === slot) return; // already there
    const selectedId = suite.steps[selected]?.id;
    const steps = [...suite.steps];
    const [moved] = steps.splice(from, 1);
    steps.splice(from < slot ? slot - 1 : slot, 0, moved);
    patchSuite({ steps });
    const nextSelected = steps.findIndex((st) => st.id === selectedId);
    if (nextSelected >= 0) setSelected(nextSelected);
  };

  const addStep = () => {
    const steps = [...suite.steps, emptyStep()];
    patchSuite({ steps });
    setSelected(steps.length - 1);
    setStepTab('request');
  };

  const addStepFromCurl = (request: StepRequest, name: string) => {
    const step = emptyStep(name);
    step.request = request;
    const steps = [...suite.steps, step];
    patchSuite({ steps });
    setSelected(steps.length - 1);
    setStepTab('request');
    setImportCurl(false);
    toast(`Added step "${name}" from cURL`);
  };

  const duplicateStep = (i: number) => {
    const copy: Step = JSON.parse(JSON.stringify(suite.steps[i]));
    copy.id = crypto.randomUUID();
    copy.name += ' (copy)';
    const steps = [...suite.steps.slice(0, i + 1), copy, ...suite.steps.slice(i + 1)];
    patchSuite({ steps });
    setSelected(i + 1);
  };

  const removeStep = (i: number) => {
    patchSuite({ steps: suite.steps.filter((_, j) => j !== i) });
    setSelected((s) => Math.max(0, Math.min(s, suite.steps.length - 2)));
    setDeletingStep(null);
  };

  const save = async (): Promise<boolean> => {
    try {
      const saved = await api.put<Suite>(`/api/suites/${suite.id}`, {
        name: suite.name,
        description: suite.description,
        steps: suite.steps,
        variables: suite.variables,
        settings: suite.settings,
        defaultEnvId: envId,
      });
      setSuite(saved);
      setDirty(false);
      toast('Suite saved');
      return true;
    } catch (e: any) {
      toast(e.message, 'error');
      return false;
    }
  };

  /** Hand off to Hera with this suite (and environment) preselected. Saves first, like run(). */
  const loadTest = async () => {
    if (dirty) await save();
    navigate(`/hera?suiteId=${id}${envId ? `&envId=${envId}` : ''}`);
  };

  const run = async () => {
    setRunning(true);
    try {
      if (dirty && !(await save())) return;
      const r = await api.post<{ id: string }>('/api/runs', { suiteId: suite.id, cycles, stopOnFailure, envId });
      navigate(`/runs/${r.id}`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setRunning(false);
    }
  };

  // Run ONE step ad-hoc with the current editor state (no save needed).
  const runStep = async (i: number) => {
    const st = suite.steps[i];
    setSelected(i);
    setStepResults((r) => ({ ...r, [st.id]: 'running' }));
    try {
      const result = await api.post<StepResult>('/api/runs/step', {
        step: st,
        suiteVariables: suite.variables,
        settings: suite.settings,
        envId,
      });
      setStepResults((r) => ({ ...r, [st.id]: result }));
      // fold suite-scope captures back into the working variables so the next
      // Send can use them — this is how you test a chain step by step
      const captured = result.captured.filter((c) => c.scope === 'suite');
      if (captured.length) {
        const vars = [...suite.variables];
        for (const c of captured) {
          const idx = vars.findIndex((v) => v.key === c.key);
          if (idx >= 0) vars[idx] = { ...vars[idx], value: c.value };
          else vars.push({ key: c.key, value: c.value, secret: false });
        }
        patchSuite({ variables: vars });
        toast(`Captured ${captured.map((c) => `{{${c.key}}}`).join(', ')} into suite variables`);
      }
    } catch (e: any) {
      setStepResults((r) => {
        const next = { ...r };
        delete next[st.id];
        return next;
      });
      toast(e.message, 'error');
    }
  };

  const step = suite.steps[selected];
  // Drag-to-reorder needs edit rights and an unfiltered list (see the note in
  // the step list below).
  const canReorder = perms.canCreate && stepQuery.trim() === '';

  // Refreshed on every render, so the one-time keydown listener always acts on
  // the step that is actually selected now.
  const sendable = !!step && stepResults[step.id] !== 'running' && !!step.request.url.trim();
  sendRef.current = sendable ? () => void runStep(selected) : null;
  modalOpenRef.current = importCurl || deletingStep !== null;

  return (
    <div>
      {/* header */}
      <div className="row mb wrap">
        <input style={{ width: 280, fontWeight: 600 }} type="text" value={suite.name} onChange={(e) => patchSuite({ name: e.target.value })} />
        <input className="grow" type="text" placeholder="description" value={suite.description} onChange={(e) => patchSuite({ description: e.target.value })} />
        {perms.canCreate && <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
          {dirty ? 'Save changes' : 'Saved'}
        </button>}
        {!perms.canCreate && <span className="role-tag npc" style={{ alignSelf: 'center' }}>Read-only</span>}
        <Info k="suite.save" />
        <label className="row" style={{ gap: 6, cursor: 'pointer', flexShrink: 0 }}
          title="Show the floating composer basket to build a new suite from selected requests">
          <input type="checkbox" checked={composerOn} onChange={(e) => toggleComposer(e.target.checked)} />
          🧺 Composer
          <Info k="suite.composer" />
        </label>
      </div>

      {/* run bar */}
      <div className="card row mb wrap">
        <b>Run suite</b>
        <Info k="suite.run" />
        <label className="row" style={{ gap: 6 }}>
          cycles
          <input style={{ width: 70 }} type="number" min={1} max={100} value={cycles} onChange={(e) => setCycles(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
          <Info k="suite.cycles" />
        </label>
        <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={stopOnFailure} onChange={(e) => setStopOnFailure(e.target.checked)} />
          stop on failure
          <Info k="suite.stopOnFailure" />
        </label>
        {/* Environment picker: applies to Run, single-step Send and the Hera
            hand-off, and is saved as this suite's default. */}
        <label className="row" style={{ gap: 6 }} title="Named variable set used for this run — overrides globals and suite variables; only runtime captures win over it">
          environment
          <select
            value={envId ?? ''}
            onChange={(e) => {
              setEnvId(e.target.value || null);
              setDirty(true);
            }}
          >
            <option value="">(none)</option>
            {envs.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </label>
        <div className="grow" />
        {dirty && <span className="muted">unsaved changes will be saved first</span>}
        <button className="btn primary" disabled={running} onClick={() => void run()}>
          {running ? 'Starting…' : '▶ Run'}
        </button>
        {perms.canLoadTest && (
          <>
            <button className="btn" disabled={running}
              title="Load-test this suite with Hera — same steps, run concurrently"
              onClick={() => void loadTest()}>⚡ Load test</button>
            <Info k="suite.loadTest" />
          </>
        )}
      </div>

      {/* suite-level tabs */}
      <div className="tabs">
        <button className={suiteTab === 'steps' ? 'active' : ''} onClick={() => setSuiteTab('steps')}>
          Steps<span className="count">({suite.steps.length})</span>
        </button>
        <button className={suiteTab === 'variables' ? 'active' : ''} onClick={() => setSuiteTab('variables')}>
          Suite variables<span className="count">({suite.variables.length})</span>
        </button>
        <button className={suiteTab === 'settings' ? 'active' : ''} onClick={() => setSuiteTab('settings')}>Settings</button>
      </div>

      {suiteTab === 'variables' && (
        <div className="card" style={{ maxWidth: 720 }}>
          <h2>Suite variables<Info k="suite.variables" /></h2>
          <KVEditor
            items={suite.variables.map((v) => ({ key: v.key, value: v.value, enabled: !v.secret }))}
            onChange={(items) => patchSuite({ variables: items.map((i) => ({ key: i.key, value: i.value, secret: !i.enabled })) })}
            keyPlaceholder="variableName"
          />
          <p className="muted">
            Checkbox = value visible (unchecked marks it secret). These are the <b>fallback</b> layer: a global or the selected
            environment with the same name wins over them, and captures made during a run win over everything.
          </p>
        </div>
      )}

      {suiteTab === 'settings' && (
        <div className="card" style={{ maxWidth: 480 }}>
          <h2>Runner settings<Info k="suite.settings" /></h2>
          <label className="field">
            <span>Default cycles</span>
            <input type="number" min={1} max={100} value={suite.settings.defaultCycles}
              onChange={(e) => patchSuite({ settings: { ...suite.settings, defaultCycles: Number(e.target.value) || 1 } })} />
          </label>
          <label className="field">
            <span>Request timeout (ms)</span>
            <input type="number" min={100} value={suite.settings.requestTimeoutMs}
              onChange={(e) => patchSuite({ settings: { ...suite.settings, requestTimeoutMs: Number(e.target.value) || 30000 } })} />
          </label>
          <label className="row mb" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={suite.settings.stopOnFailure}
              onChange={(e) => patchSuite({ settings: { ...suite.settings, stopOnFailure: e.target.checked } })} />
            Stop on failure by default
          </label>
          <label className="row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={suite.settings.runCapturesOnFailure}
              onChange={(e) => patchSuite({ settings: { ...suite.settings, runCapturesOnFailure: e.target.checked } })} />
            Run captures even when the step failed
          </label>
        </div>
      )}

      {suiteTab === 'steps' && (
        <div className="editor">
          {/* step list */}
          <div className="step-list"
            /* Column-level fallback: rows are 6px apart, and without this a drop
               that lands in one of those gaps would cancel the drag even though
               the insertion line was showing. The last indicated slot is used,
               so what you saw is what you get. */
            onDragOver={(e) => { if (dragFrom !== null && dropSlot !== null) e.preventDefault(); }}
            onDrop={(e) => {
              if (dragFrom === null || dropSlot === null) return;
              e.preventDefault();
              const from = dragFrom;
              const slot = dropSlot;
              setDragFrom(null);
              setDropSlot(null);
              moveStepTo(from, slot);
            }}>
            <div className="step-search">
              <input type="text" placeholder="🔍 Search steps by name, method, URL…" value={stepQuery}
                onChange={(e) => setStepQuery(e.target.value)} />
              {stepQuery && <button className="btn icon" title="Clear search" onClick={() => setStepQuery('')}>✕</button>}
              <Info k="step.search" />
            </div>
            {(() => {
              const q = stepQuery.trim().toLowerCase();
              const matches = (st: Step) =>
                !q || [st.name, st.request.method, st.request.url, st.folderPath].some((v) => (v || '').toLowerCase().includes(q));
              const visible = suite.steps.filter(matches).length;
              if (q && visible === 0) return <p className="muted" style={{ fontSize: 12 }}>No steps match “{stepQuery}”.</p>;
              return null;
            })()}
            {/* Reordering is off while the list is filtered: the rows you see are
                a subset, so "drop below this one" would land the step next to a
                neighbour that isn't actually adjacent. ↑/↓ still work. */}
            {perms.canCreate && stepQuery.trim() !== '' && (
              <p className="muted" style={{ fontSize: 11 }}>Clear the filter to drag steps into a new order.</p>
            )}
            {suite.steps.map((st, i) => {
              const q = stepQuery.trim().toLowerCase();
              const matches = !q || [st.name, st.request.method, st.request.url, st.folderPath].some((v) => (v || '').toLowerCase().includes(q));
              if (!matches) return null;
              const dropClass = dropSlot === i ? 'drop-above' : dropSlot === i + 1 ? 'drop-below' : '';
              return (
              <div key={st.id}
                className={[
                  'step-item',
                  i === selected ? 'selected' : '',
                  st.enabled ? '' : 'disabled',
                  canReorder || composerOn ? 'draggable' : '',
                  dragFrom === i ? 'drag-src' : '',
                  dropClass,
                ].filter(Boolean).join(' ')}
                onClick={() => setSelected(i)}
                draggable={canReorder || composerOn}
                onDragStart={(e) => {
                  // Two payloads, one drag: the composer basket reads
                  // 'text/step-index', the list below reads 'text/step-reorder'.
                  // Keeping them separate is what lets both drops coexist.
                  e.dataTransfer.setData('text/step-index', String(i));
                  if (canReorder) {
                    e.dataTransfer.setData('text/step-reorder', String(i));
                    e.dataTransfer.effectAllowed = 'move';
                    setDragFrom(i);
                  }
                }}
                onDragOver={(e) => {
                  if (!canReorder || dragFrom === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  // Top half inserts before this row, bottom half after it.
                  const box = e.currentTarget.getBoundingClientRect();
                  setDropSlot(e.clientY < box.top + box.height / 2 ? i : i + 1);
                }}
                onDrop={(e) => {
                  if (!canReorder) return;
                  const raw = e.dataTransfer.getData('text/step-reorder');
                  const from = Number(raw);
                  e.preventDefault();
                  e.stopPropagation();
                  const slot = dropSlot;
                  setDragFrom(null);
                  setDropSlot(null);
                  if (raw === '' || Number.isNaN(from) || slot === null) return;
                  moveStepTo(from, slot);
                }}
                onDragEnd={() => { setDragFrom(null); setDropSlot(null); }}>
                {(canReorder || composerOn) && (
                  <span className="step-grip" title={canReorder ? 'Drag to reorder' : 'Drag onto the composer basket'}>⠿</span>
                )}
                <input type="checkbox" checked={st.enabled} title="Enable/disable this step (disabled steps are skipped)"
                  onClick={(e) => e.stopPropagation()} onChange={(e) => patchStep(i, { enabled: e.target.checked })} />
                <span className={`chip ${st.request.method}`}>{st.request.method}</span>
                {/* The name is the thing you actually read down this list, so it
                    gets the full width at rest — the actions below only take
                    space once the row is hovered, focused or selected. */}
                <span className="name" title={st.name || '(unnamed)'}>
                  {st.name || <span className="muted">(unnamed)</span>}
                  {st.folderPath && <span className="folder">{st.folderPath}</span>}
                </span>
                <span className="step-actions">
                  {composerOn && (
                    <button className="btn icon" title="Add this request to the composer basket"
                      onClick={(e) => { e.stopPropagation(); addToComposer(i); }}>＋</button>
                  )}
                  <button className="btn icon" title="Run only this step (uses current edits, nothing is saved)"
                    disabled={stepResults[st.id] === 'running'}
                    onClick={(e) => { e.stopPropagation(); void runStep(i); }}>▶</button>
                  {perms.canCreate && <button className="btn icon" title="Move up" onClick={(e) => { e.stopPropagation(); moveStep(i, -1); }}>↑</button>}
                  {perms.canCreate && <button className="btn icon" title="Move down" onClick={(e) => { e.stopPropagation(); moveStep(i, 1); }}>↓</button>}
                  {perms.canCreate && <button className="btn icon" title="Duplicate step" onClick={(e) => { e.stopPropagation(); duplicateStep(i); }}>⧉</button>}
                  {perms.canDelete && <button className="btn icon danger" title="Delete step" onClick={(e) => { e.stopPropagation(); setDeletingStep(i); }}>✕</button>}
                </span>
              </div>
              );
            })}
            {/* Explicit tail target: without it there is no row whose bottom half
                means "last", so a step could never be dragged to the end. */}
            {canReorder && dragFrom !== null && (
              <div className={`step-drop-tail ${dropSlot === suite.steps.length ? 'active' : ''}`}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropSlot(suite.steps.length); }}
                onDrop={(e) => {
                  const raw = e.dataTransfer.getData('text/step-reorder');
                  const from = Number(raw);
                  e.preventDefault();
                  setDragFrom(null);
                  setDropSlot(null);
                  if (raw !== '' && !Number.isNaN(from)) moveStepTo(from, suite.steps.length);
                }}>
                drop here to move to the end
              </div>
            )}
            {perms.canCreate && (
              <div className="row" style={{ gap: 6 }}>
                <button className="btn grow" onClick={addStep}>+ Add step</button>
                <button className="btn" onClick={() => setImportCurl(true)} title="Create a step by pasting a cURL command">Import cURL</button>
              </div>
            )}
            <p className="muted" style={{ fontSize: 11 }}>
              Steps run top to bottom — captures from earlier steps feed later ones.
              <Info k="step.reorder" />
            </p>
          </div>

          {/* step detail */}
          <div className="step-detail card" ref={detailRef}>
            {step ? (
              <>
                <div className="row mb">
                  <input className="grow" type="text" value={step.name} placeholder="Step name" disabled={!perms.canCreate}
                    onChange={(e) => patchStep(selected, { name: e.target.value })} />
                  <label className="row" style={{ gap: 6, cursor: 'pointer', flexShrink: 0 }}>
                    <input type="checkbox" checked={step.enabled} disabled={!perms.canCreate} onChange={(e) => patchStep(selected, { enabled: e.target.checked })} />
                    enabled
                    <Info k="step.enabled" />
                  </label>
                  <button className="btn primary" style={{ flexShrink: 0 }}
                    title="Send this request — ⌘/Ctrl + Enter"
                    disabled={stepResults[step.id] === 'running' || !step.request.url.trim()}
                    onClick={() => void runStep(selected)}>
                    {stepResults[step.id] === 'running' ? 'Sending…' : '▶ Send'}
                  </button>
                  <Info k="step.send" />
                </div>

                <div className="tabs">
                  <button className={stepTab === 'request' ? 'active' : ''} onClick={() => setStepTab('request')}>
                    Request<Info k="step.request" />
                  </button>
                  <button className={stepTab === 'validate' ? 'active' : ''} onClick={() => setStepTab('validate')}>
                    Validate<span className="count">({step.validations.visual.length + (step.validations.script.trim() ? 1 : 0)})</span>
                    <Info k="step.validate" />
                  </button>
                  <button className={stepTab === 'capture' ? 'active' : ''} onClick={() => setStepTab('capture')}>
                    Capture<span className="count">({step.captures.visual.length + (step.captures.script.trim() ? 1 : 0)})</span>
                    <Info k="step.capture" />
                  </button>
                  <button className={stepTab === 'poll' ? 'active' : ''} onClick={() => setStepTab('poll')}
                    title="Re-send this request on an interval until a stop condition is met">
                    Poll{step.polling?.enabled && <span className="count" style={{ color: 'var(--success)' }}>on</span>}
                  </button>
                </div>

                {/* Pinned above the scroll: method, URL and the placeholder chips.
                    Kept out of the scrolling body on purpose — the URL is what you
                    check while editing params, a body or an assertion. */}
                <fieldset className="editor-fieldset step-detail-url" disabled={!perms.canCreate}>
                  <RequestUrlRow step={step} stepIndex={selected} steps={suite.steps} suiteVars={suite.variables}
                    globals={globals} onChange={(p) => patchStep(selected, p)} onGlobalsChanged={loadGlobals} />
                </fieldset>

                {/* Everything from here down scrolls inside the panel, so the wheel
                    works with the cursor over the step instead of only outside it. */}
                <div className="step-detail-body" ref={detailBodyRef}>
                {/* fieldset disabled makes every editing control inside read-only for
                    roles without canCreate (npc); Send/Run above stay usable */}
                <fieldset className="editor-fieldset" disabled={!perms.canCreate}>
                  {stepTab === 'request' && (
                    <RequestTab step={step} stepIndex={selected} steps={suite.steps} suiteVars={suite.variables}
                      globals={globals} onChange={(p) => patchStep(selected, p)} onGlobalsChanged={loadGlobals} />
                  )}
                  {stepTab === 'validate' && (
                    <ValidateTab step={step} stepIndex={selected} steps={suite.steps} suiteVars={suite.variables}
                      globals={globals} onChange={(p) => patchStep(selected, p)} onGlobalsChanged={loadGlobals} />
                  )}
                  {stepTab === 'capture' && (
                    <CaptureTab step={step} stepIndex={selected} steps={suite.steps} suiteVars={suite.variables}
                      globals={globals} onChange={(p) => patchStep(selected, p)} onGlobalsChanged={loadGlobals} />
                  )}
                  {stepTab === 'poll' && (
                    <PollTab step={step} stepIndex={selected} steps={suite.steps} suiteVars={suite.variables}
                      globals={globals} onChange={(p) => patchStep(selected, p)} onGlobalsChanged={loadGlobals} />
                  )}
                </fieldset>

                {/* Outside the fieldset on purpose: the bench sends no request and
                    saves nothing, so read-only roles may use it like Send. */}
                {stepTab !== 'request' && (
                  <ScriptBench
                    mode={stepTab}
                    step={step}
                    suiteVars={suite.variables}
                    envId={envId}
                    lastResult={stepResults[step.id]}
                    onRunnableChange={setBenchRunnable}
                  />
                )}

                {stepResults[step.id] && stepResults[step.id] !== 'running' && (
                  <StepRunResult result={stepResults[step.id] as StepResult}
                    onDismiss={() => setStepResults((r) => {
                      const next = { ...r };
                      delete next[step.id];
                      return next;
                    })} />
                )}
                </div>
              </>
            ) : (
              <div className="muted">This suite has no steps yet — click “+ Add step”.</div>
            )}
          </div>
        </div>
      )}

      {composerOn && (
        <ComposerBox
          items={composerItems}
          onChange={changeComposerItems}
          onClose={() => toggleComposer(false)}
          onDropStep={addToComposer}
        />
      )}

      {deletingStep !== null && (
        <Confirm
          message={`Delete step "${suite.steps[deletingStep].name}"?`}
          onYes={() => removeStep(deletingStep)}
          onNo={() => setDeletingStep(null)}
        />
      )}
      {importCurl && <CurlImportModal onClose={() => setImportCurl(false)} onImport={addStepFromCurl} />}
    </div>
  );
}

/** Paste a cURL command → parse it into a new request step. */
function CurlImportModal({ onClose, onImport }: { onClose: () => void; onImport: (req: StepRequest, name: string) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const doImport = () => {
    setError('');
    try {
      const { request, name } = parseCurl(text);
      onImport(request, name);
    } catch (e: any) {
      setError(e?.message || 'Could not parse that cURL command.');
    }
  };

  return (
    <Modal title="Import cURL" onClose={onClose}>
      <p className="muted">
        Paste a cURL command (e.g. a browser's <b>Copy as cURL</b>, or one exported from a Hermes step). It becomes a new
        step — method, URL, headers, body and basic auth are mapped. <span className="mono">{'{{variables}}'}</span> are kept as-is.
      </p>
      <textarea className="code" rows={10} autoFocus placeholder={"curl 'https://api.example.com/login' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{\"user\":\"ada\"}'"}
        value={text} onChange={(e) => setText(e.target.value)} />
      {error && <div className="error-text mt">{error}</div>}
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!text.trim()} onClick={doImport}>Add step</button>
      </div>
    </Modal>
  );
}

/** Inline response viewer for a single ad-hoc step run. */
function StepRunResult({ result, onDismiss }: { result: StepResult; onDismiss: () => void }) {
  return (
    <div className="step-run-result">
      <div className="row mb">
        <h3 className="grow" style={{ margin: 0 }}>
          Response <span className={`chip status-${result.status}`}>{result.status}</span>{' '}
          {result.response && <span className="muted">HTTP {result.response.status} · {result.response.timeMs} ms</span>}
        </h3>
        <button className="btn small" onClick={onDismiss}>✕ dismiss</button>
      </div>

      {result.error && <div className="error-text mb">{result.error}</div>}
      {result.request && <div className="mono muted mb">{result.request.method} {result.request.url}</div>}

      {result.curl && <CurlBlock curl={result.curl} />}

      {result.assertions.length > 0 && (
        <div className="mb">
          <h3>Assertions</h3>
          {result.assertions.map((a, i) => (
            <div className="assertion" key={i}>
              <span className={a.passed ? 'ok' : 'bad'}>{a.passed ? '✓' : '✗'}</span>
              <span>{a.name}</span>
              {a.message && <span className="muted">— {a.message}</span>}
            </div>
          ))}
        </div>
      )}

      {result.captured.length > 0 && (
        <div className="mb">
          <h3>Captured variables</h3>
          {result.captured.map((c, i) => (
            <div className="assertion" key={i}>
              <span className="mono">{'{{' + c.key + '}}'}</span>
              <span className="muted">= {c.value.length > 120 ? c.value.slice(0, 120) + '…' : c.value} ({c.scope})</span>
            </div>
          ))}
        </div>
      )}

      {result.logs.length > 0 && (
        <div className="mb">
          <h3>Script logs</h3>
          <pre className="body-view">{result.logs.join('\n')}</pre>
        </div>
      )}

      {result.pollAttempts && <PollAttempts attempts={result.pollAttempts} />}

      {result.response && (
        <div>
          <h3>{result.pollAttempts ? 'Final response' : 'Body'}</h3>
          <BodyViewer body={result.response.body} truncated={result.response.bodyTruncated} />
        </div>
      )}
    </div>
  );
}

/** Copyable cURL of the exact request sent — for debugging outside the app. */
