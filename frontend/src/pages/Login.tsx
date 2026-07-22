import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../App';
import { Info } from '../legends';
import type { User } from '../types';

interface Captcha {
  id: string;
  svg: string;
}

export default function Login() {
  const { setUser } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState<Captcha | null>(null);
  const [captchaText, setCaptchaText] = useState('');
  // Allowlisted accounts skip the captcha — the backend tells us per username.
  const [captchaRequired, setCaptchaRequired] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshCaptcha = useCallback(() => {
    setCaptchaText('');
    api.get<Captcha>('/api/auth/captcha').then(setCaptcha).catch(() => setError('Could not load captcha — is the backend running?'));
  }, []);

  useEffect(() => {
    refreshCaptcha();
  }, [refreshCaptcha]);

  // Debounced lookup: does this username still need the captcha?
  useEffect(() => {
    const name = username.trim();
    if (!name) {
      setCaptchaRequired(true);
      return;
    }
    const t = setTimeout(() => {
      api
        .get<{ required: boolean }>(`/api/auth/captcha-required?username=${encodeURIComponent(name)}`)
        .then((r) => setCaptchaRequired(r.required))
        .catch(() => setCaptchaRequired(true)); // fail safe: keep the captcha
    }, 350);
    return () => clearTimeout(t);
  }, [username]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (captchaRequired && !captcha) return;
    setBusy(true);
    setError('');
    try {
      const body = captchaRequired
        ? { username, password, captchaId: captcha!.id, captchaText }
        : { username, password };
      const u = await api.post<User>('/api/auth/login', body);
      setUser(u);
    } catch (err) {
      const ae = err as ApiError;
      setError(ae.message);
      if (captchaRequired) refreshCaptcha(); // captcha is single-use
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>⚡ Hermes<span className="tm">™</span><Info k="app.name" /></h1>
        <label className="field">
          <span>Username</span>
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {captchaRequired ? (
          <label className="field">
            <span>Captcha — click image to refresh<Info k="login.captcha" /></span>
            {captcha ? (
              <div className="captcha-box mb" onClick={refreshCaptcha} title="Click for a new captcha"
                dangerouslySetInnerHTML={{ __html: captcha.svg }} />
            ) : (
              <div className="captcha-box mb muted">loading…</div>
            )}
            <input type="text" value={captchaText} onChange={(e) => setCaptchaText(e.target.value)} placeholder="Type the characters above" />
          </label>
        ) : (
          <div className="captcha-exempt-note mb">✓ This account is allowlisted — no captcha required.</div>
        )}
        {error && <div className="error-text mb">{error}</div>}
        <button className="btn primary" style={{ width: '100%' }}
          disabled={busy || !username || !password || (captchaRequired && !captchaText)}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
