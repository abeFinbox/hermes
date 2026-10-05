import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Info } from '../legends';
import { Confirm, useToast } from '../ui';
import type { Environment, HeraCapability, HeraPreflight, HeraProfilePreview, HeraRunListItem, Suite, SuiteListItem } from '../types';

/**
 * Launch a load test.
 *
 * Two deliberate deviations from the rest of the app's form idioms:
 *
 *  - numeric fields keep a RAW STRING in state and clamp on blur. SuiteEditor
 *    clamps on change, which is fine when min is 1, but here typing "30" into a
 *    field with min 5 would clamp the intermediate "3" up to 5 and leave "50".
 *  - out-of-range feedback is inline, not a toast: a toast that vanishes in
 *    2.5s is the wrong channel for a field that is still wrong.
 */

interface Props {
  caps: HeraCapability | null;
  /** Preselect, e.g. arriving from the suite editor's Load test button. */
  initialSuiteId?: string | null;
  /** Preselect an environment, carried over from the suite editor. */
  initialEnvId?: string | null;
  /** A run already in flight — only one may run at a time, cluster-wide. */
  activeRun: HeraRunListItem | null;
  onLaunched: () => void;
}

export default function HeraLaunchForm({ caps, initialSuiteId, initialEnvId, activeRun, onLaunched }: Props) {
  const [suites, setSuites] = useState<SuiteListItem[]>([]);
  const [suiteId, setSuiteId] = useState('');
  const [envs, setEnvs] = useState<Environment[]>([]);
  // '' = no environment. Seeded from the URL, else from the suite's default —
  // so the preflight below previews exactly what a launch would resolve.
  const [envId, setEnvId] = useState(initialEnvId ?? '');
  const [envTouched, setEnvTouched] = useState(!!initialEnvId);
  const [vus, setVus] = useState('5');
  const [duration, setDuration] = useState('30');
  const [useP95, setUseP95] = useState(false);
  const [p95, setP95] = useState('500');
  const [useErrRate, setUseErrRate] = useState(false);
  const [errRate, setErrRate] = useState('1');
  const [mode, setMode] = useState('constant');
  const [rate, setRate] = useState('');
  const [profile, setProfile] = useState<HeraProfilePreview | null>(null);
  const [pre, setPre] = useState<HeraPreflight | null>(null);
  const [preLoading, setPreLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    api
      .get<SuiteListItem[]>('/api/suites')
      .then((s) => {
        setSuites(s);
        const preferred = initialSuiteId && s.some((x) => x.id === initialSuiteId) ? initialSuiteId : s[0]?.id;
        if (preferred && !suiteId) setSuiteId(preferred);
      })
      .catch((e) => toast(e.message, 'error'));
    api.get<Environment[]>('/api/environments').then(setEnvs).catch(() => {});
  }, []);

  // Adopt the suite's default environment when the user hasn't chosen one, so
  // "Load test" from the editor and a bare visit both start from the same place.
  useEffect(() => {
    if (!suiteId || envTouched) return;
    api
      .get<Suite>(`/api/suites/${suiteId}`)
      .then((s) => setEnvId(s.defaultEnvId ?? ''))
      .catch(() => {});
  }, [suiteId, envTouched]);

  // Preflight resolves targets server-side — the browser cannot do it, because a
  // URL may depend on a value captured by an earlier step. envId is sent so the
  // hosts shown are the ones the chosen environment actually points at.
  useEffect(() => {
    if (!suiteId) return;
    setPreLoading(true);
    api
      .get<HeraPreflight>(`/api/hera/preflight?suiteId=${suiteId}&envId=${encodeURIComponent(envId)}`)
      .then(setPre)
      .catch(() => setPre(null))
      .finally(() => setPreLoading(false));
  }, [suiteId, envId]);

  // Debounced: this fires while a number is still being typed, and it is a pure
  // server-side calculation with no suite involved.
  useEffect(() => {
    const t = setTimeout(() => {
      const n = (v: string, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : d);
      api
        .get<HeraProfilePreview>(`/api/hera/profile?mode=${mode}&vus=${n(vus, 1)}&durationSec=${n(duration, 1)}${mode === 'rate' && rate ? `&ratePerSec=${n(rate, 1)}` : ''}`)
        .then(setProfile)
        .catch(() => setProfile(null));
    }, 250);
    return () => clearTimeout(t);
  }, [mode, vus, duration, rate]);

  const maxVus = caps?.maxVus ?? 1;
  const maxDur = caps?.maxDurationSec ?? 1;
  const nVus = Math.trunc(Number(vus) || 0);
  const nDur = Math.trunc(Number(duration) || 0);
  const suite = suites.find((s) => s.id === suiteId);

  const clamp = (raw: string, min: number, max: number) =>
    String(Math.max(min, Math.min(max, Math.trunc(Number(raw) || min))));

  const vusError = nVus > maxVus ? `max ${maxVus} on this server` : nVus < 1 ? 'must be at least 1' : '';
  const durError = nDur > maxDur ? `max ${maxDur}s on this server` : nDur < 1 ? 'must be at least 1s' : '';

  const externalHosts = (pre?.hosts ?? []).filter((h) => h.external);
  const blockingFindings = (pre?.findings ?? []).filter((f) => f.level === 'error');
  const canLaunch = !!caps?.available && !!caps?.canLaunch && !activeRun;
  const formValid = !!suiteId && !vusError && !durError && !!pre?.ok && !preLoading;

  // Friction proportional to the request. Firing a confirm on every 5-VU smoke
  // test just teaches people to click through it.
  const isBig = nVus > 20 || nDur > 120 || externalHosts.length > 0;

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ id: string; appliedConfig: { vus: number; durationSec: number }; clampNotes: string[] }>(
        '/api/hera',
        {
          suiteId,
          mode,
          ratePerSec: mode === 'rate' && rate ? Math.trunc(Number(rate) || 0) : null,
          vus: nVus,
          durationSec: nDur,
          p95Ms: useP95 ? Math.trunc(Number(p95) || 0) : null,
          errorRatePct: useErrRate ? Math.trunc(Number(errRate) || 0) : null,
          // Explicit null (not undefined) so "(none)" overrides the suite default.
          envId: envId || null,
        },
      );
      if (res.clampNotes?.length) {
        // A limit doing its job, not a failure — but say both numbers.
        toast(`Server capped this test: ${res.clampNotes.join(' ')}`);
      }
      onLaunched();
      navigate(`/hera/${res.id}`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const perIteration = pre?.estimate.requestsPerIteration ?? 0;
  const estimate = pre?.estimate.unbounded
    ? `${perIteration} step(s) per iteration · request count unbounded (polling)`
    : `≈ ${perIteration} request(s) per iteration · ${nVus} VUs for ~${nDur}s → roughly ${perIteration * nVus * Math.max(1, Math.round(nDur / 2))} requests. Actual count depends on how fast the target responds.`;

  return (
    <>
      <div className="card mb">
        <div className="row wrap">
          <b>New load test</b>
          <Info k="hera.launch" />

          <label className="field" style={{ margin: 0, minWidth: 240 }}>
            <span>Suite</span>
            <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)} disabled={!canLaunch}>
              {suites.length === 0 && <option value="">No suites yet</option>}
              {suites.map((s) => (
                <option key={s.id} value={s.id}>{s.name} — {s.stepCount} steps</option>
              ))}
            </select>
          </label>

          <label className="field" style={{ margin: 0, minWidth: 180 }}>
            <span>Environment</span>
            <select
              value={envId}
              disabled={!canLaunch}
              title="Named variable set every virtual user resolves against — overrides globals and suite variables"
              onChange={(e) => {
                setEnvId(e.target.value);
                setEnvTouched(true);
              }}
            >
              <option value="">(none)</option>
              {envs.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </label>

          <label className="field" style={{ margin: 0, minWidth: 200 }}>
            <span>Mode<Info k="hera.mode" /></span>
            <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={!canLaunch}>
              {(profile?.modes ?? [{ mode: 'constant', label: 'Constant' }]).map((m) => (
                <option key={m.mode} value={m.mode}>{m.label.split(' — ')[0]}</option>
              ))}
            </select>
          </label>

          <label className="field" style={{ margin: 0 }}>
            <span>{mode === 'rate' ? 'Max virtual users' : 'Virtual users'}<Info k="hera.vus" /></span>
            <input type="number" min={1} max={maxVus} style={{ width: 90 }} value={vus} disabled={!canLaunch}
              onChange={(e) => setVus(e.target.value)}
              onBlur={() => setVus(clamp(vus, 1, maxVus))} />
            <span className="muted" style={{ fontSize: 11 }}>max {maxVus}</span>
          </label>

          {mode === 'rate' && (
            <label className="field" style={{ margin: 0 }}>
              <span>Iterations/s<Info k="hera.rate" /></span>
              <input type="number" min={1} max={profile?.maxRps ?? 1} style={{ width: 100 }}
                value={rate} placeholder={String(profile?.maxRps ?? '')} disabled={!canLaunch}
                onChange={(e) => setRate(e.target.value)}
                onBlur={() => setRate(rate ? clamp(rate, 1, profile?.maxRps ?? 1) : '')} />
              <span className="muted" style={{ fontSize: 11 }}>max {profile?.maxRps ?? '—'}</span>
            </label>
          )}

          <label className="field" style={{ margin: 0 }}>
            <span>Duration (s)<Info k="hera.duration" /></span>
            <input type="number" min={1} max={maxDur} step={5} style={{ width: 100 }} value={duration} disabled={!canLaunch}
              onChange={(e) => setDuration(e.target.value)}
              onBlur={() => setDuration(clamp(duration, 1, maxDur))} />
            <span className="muted" style={{ fontSize: 11 }}>max {maxDur}s</span>
          </label>

          <div className="grow" />
          <button className="btn primary" disabled={!canLaunch || !formValid || busy}
            onClick={() => (isBig ? setConfirming(true) : void submit())}>
            {busy ? 'Starting…' : '▶ Start load test'}
          </button>
        </div>

        {(vusError || durError) && (
          <div className="error-text mt">{[vusError, durError].filter(Boolean).join(' · ')}</div>
        )}

        {/* The shape comes from the server, never derived here: one profile
            implementation per language, both under the parity harness. */}
        {profile && (
          <div className="muted mt" style={{ fontSize: 12 }}>
            <b>{profile.summary}</b>
            {profile.stages.length > 0 && (
              <span className="mono"> — {profile.stages.map((s) => `${s.durationSec}s→${s.target}`).join(', ')}</span>
            )}
            {profile.notes.map((n, i) => (
              <div key={i} className="error-text" style={{ fontSize: 12 }}>{n}</div>
            ))}
          </div>
        )}

        {suite && !preLoading && pre && (
          <div className="muted mt" style={{ fontSize: 12 }}>{estimate}</div>
        )}

        <details className="step-res mt">
          <summary>
            Advanced <span className="muted">thresholds</span>
          </summary>
          <div className="detail-body">
            <div className="hera-form-grid">
              <label className="field">
                <span>
                  <input type="checkbox" checked={useP95} onChange={(e) => setUseP95(e.target.checked)} disabled={!canLaunch} />{' '}
                  p95 latency below (ms)<Info k="hera.thresholds" />
                </span>
                <input type="number" min={1} value={p95} disabled={!canLaunch || !useP95}
                  onChange={(e) => setP95(e.target.value)} />
              </label>
              <label className="field">
                <span>
                  <input type="checkbox" checked={useErrRate} onChange={(e) => setUseErrRate(e.target.checked)} disabled={!canLaunch} />{' '}
                  Error rate below (%)
                </span>
                <input type="number" min={0} max={100} value={errRate} disabled={!canLaunch || !useErrRate}
                  onChange={(e) => setErrRate(e.target.value)} />
              </label>
            </div>
            {!useP95 && !useErrRate && (
              <div className="muted" style={{ fontSize: 12 }}>
                No thresholds set — this test reports <b>passed</b> as long as k6 finishes and no script errors occur,
                however slow the responses were.
              </div>
            )}
          </div>
        </details>

        {pre && (pre.steps.length > 0 || pre.findings.length > 0) && (
          <details className="step-res mt">
            <summary>
              Targets — <b>{pre.hosts.length} host(s)</b>, {pre.estimate.requestsPerIteration} request(s) per iteration
              {externalHosts.length > 0 && <> · <span className="chip external">external</span></>}
              <Info k="hera.targets" />
            </summary>
            <div className="detail-body">
              <div className="hera-targets">
                {pre.steps.map((s) => (
                  <div key={s.stepId}>
                    <span className={`chip ${s.method}`}>{s.method}</span>{' '}
                    {s.target.ok ? (
                      <>
                        {s.resolvedUrl}
                        {s.target.resolvedIp && <span className="muted"> → pinned {s.target.resolvedIp}</span>}
                      </>
                    ) : (
                      <span className="unresolved">{s.resolvedUrl} — {s.target.reason}</span>
                    )}
                    {s.unresolvedTokens.length > 0 && (
                      <span className="muted"> · runtime token(s): {s.unresolvedTokens.map((t) => `{{${t}}}`).join(', ')}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </details>
        )}

        {pre?.findings.map((f, i) => (
          <div key={i} className={`hera-notice mt ${f.level === 'error' ? 'error' : f.level === 'info' ? 'info' : ''}`}>
            {f.message}
          </div>
        ))}

        {blockingFindings.length === 0 && activeRun && (
          <div className="hera-notice mt">
            A load test is already running ({activeRun.suiteName}). Only one runs at a time so results stay comparable.
          </div>
        )}
      </div>

      {confirming && (
        <Confirm
          message={
            `Start a load test with ${nVus} virtual users for ${nDur}s against ` +
            `${(pre?.hosts ?? []).map((h) => h.origin).join(', ') || 'the selected suite'}` +
            `${envId ? ` using environment "${envs.find((e) => e.id === envId)?.name ?? envId}"` : ' with no environment'}? ` +
            `Each user walks all ${perIteration} step(s) repeatedly, so expect up to ${nVus} requests in flight, ` +
            `generated from this Hermes server.`
          }
          onYes={() => void submit()}
          onNo={() => setConfirming(false)}
        />
      )}
    </>
  );
}
