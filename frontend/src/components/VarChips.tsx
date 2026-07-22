import { useState } from 'react';
import { api } from '../api';
import { Info } from '../legends';
import { Modal, useToast } from '../ui';
import type { GlobalVariable, Step, SuiteVariable } from '../types';

/**
 * Scans a step's fields for {{placeholders}}, shows each as a chip:
 * green = defined (global, suite var, or captured by an EARLIER step),
 * red = undefined, with a one-click "define as global" action.
 */

export function tokensInStep(step: Step): string[] {
  const texts: string[] = [step.request.url, step.request.body.content];
  for (const h of step.request.headers) texts.push(h.key, h.value);
  for (const p of step.request.params) texts.push(p.key, p.value);
  const a = step.request.auth;
  if (a.type === 'bearer') texts.push(a.token);
  if (a.type === 'basic') texts.push(a.username, a.password);
  const found = new Set<string>();
  for (const t of texts) {
    for (const m of (t || '').matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) found.add(m[1]);
  }
  return [...found];
}

export function capturedBefore(steps: Step[], stepIndex: number): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < stepIndex; i++) {
    for (const c of steps[i].captures.visual) if (c.targetVariable) s.add(c.targetVariable);
    for (const m of (steps[i].captures.script || '').matchAll(/variables\.set\(\s*['"`]([^'"`]+)['"`]/g)) s.add(m[1]);
  }
  return s;
}

export default function VarChips({
  step, stepIndex, steps, suiteVars, globals, onGlobalsChanged,
}: {
  step: Step;
  stepIndex: number;
  steps: Step[];
  suiteVars: SuiteVariable[];
  globals: GlobalVariable[];
  onGlobalsChanged: () => void;
}) {
  const [promoting, setPromoting] = useState<string | null>(null);
  const tokens = tokensInStep(step);
  if (tokens.length === 0) return null;

  const captured = capturedBefore(steps, stepIndex);
  const defined = new Set<string>([...globals.map((g) => g.key), ...suiteVars.map((v) => v.key), ...captured]);

  return (
    <div className="var-chips">
      {tokens.map((t) => {
        const isDefined = defined.has(t);
        const src = captured.has(t) ? 'captured by an earlier step'
          : suiteVars.some((v) => v.key === t) ? 'suite variable'
          : globals.some((g) => g.key === t) ? 'global variable' : '';
        return (
          <span key={t} className={`var-chip ${isDefined ? 'defined' : 'undefined'}`} title={isDefined ? `{{${t}}} — ${src}` : `{{${t}}} is not defined anywhere`}>
            {'{{'}{t}{'}}'}
            {!isDefined && (
              <>
                <button onClick={() => setPromoting(t)}>define as global</button>
                <Info k="variables.promote" />
              </>
            )}
          </span>
        );
      })}
      {promoting && (
        <PromoteModal name={promoting} onClose={() => setPromoting(null)} onDone={() => { setPromoting(null); onGlobalsChanged(); }} />
      )}
    </div>
  );
}

function PromoteModal({ name, onClose, onDone }: { name: string; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(false);
  const toast = useToast();

  const save = async () => {
    try {
      await api.post('/api/variables', { key: name, value, secret });
      toast(`Global variable {{${name}}} created`);
      onDone();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Modal title={`Define global variable {{${name}}}`} onClose={onClose}>
      <label className="field">
        <span>Value</span>
        <input type={secret ? 'password' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </label>
      <label className="row mb" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> Secret (mask in UI)
      </label>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => void save()}>Save to globals</button>
      </div>
    </Modal>
  );
}
