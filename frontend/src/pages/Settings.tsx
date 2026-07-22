import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../App';
import { useToast, Confirm } from '../ui';
import type { User, Role } from '../types';
import { permsFor, ROLE_LABELS } from '../perms';
import EngineSelector from '../components/EngineSelector';

export default function Settings() {
  const { user } = useAuth();
  const perms = permsFor(user?.role, user?.isAdmin);
  return (
    <div>
      <h1>Settings</h1>
      <div className="row wrap" style={{ alignItems: 'flex-start' }}>
        <ChangePassword />
        <EngineSelector canSwitch={perms.canSwitchEngine} />
        {perms.canManageUsers && <UserManagement />}
      </div>
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const toast = useToast();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      toast('New passwords do not match', 'error');
      return;
    }
    try {
      await api.post('/api/auth/change-password', { currentPassword: current, newPassword: next });
      toast('Password changed');
      setCurrent(''); setNext(''); setConfirm('');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <form className="card" style={{ width: 340 }} onSubmit={submit}>
      <h2>Change password</h2>
      <label className="field"><span>Current password</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></label>
      <label className="field"><span>New password (min 6 chars)</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></label>
      <label className="field"><span>Repeat new password</span>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></label>
      <button className="btn primary" disabled={!current || next.length < 6}>Change password</button>
    </form>
  );
}

function UserManagement() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('moderator');
  const [captchaExempt, setCaptchaExempt] = useState(false);
  const [deleting, setDeleting] = useState<User | null>(null);
  const toast = useToast();

  const load = () => api.get<User[]>('/api/users').then(setUsers).catch((e) => toast(e.message, 'error'));
  useEffect(() => { void load(); }, []);

  const add = async () => {
    try {
      await api.post('/api/users', { username, password, role, captchaExempt });
      toast(`User "${username}" created`);
      setUsername(''); setPassword(''); setRole('moderator'); setCaptchaExempt(false);
      void load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const toggleExempt = async (u: User) => {
    try {
      await api.patch(`/api/users/${u.id}`, { captchaExempt: !u.captchaExempt });
      setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, captchaExempt: !u.captchaExempt } : x)));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const remove = async (u: User) => {
    try {
      await api.del(`/api/users/${u.id}`);
      setDeleting(null);
      void load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="card grow" style={{ maxWidth: 560 }}>
      <h2>Users (admin)</h2>
      <table className="list mb">
        <thead><tr><th>Username</th><th>Role</th><th>Captcha</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}{u.id === me?.id && <span className="muted"> (you)</span>}</td>
              <td><span className={`role-tag ${u.role}`}>{ROLE_LABELS[u.role]}</span></td>
              <td>
                <button
                  className={`btn small${u.captchaExempt ? '' : ' muted'}`}
                  title={u.captchaExempt ? 'This user skips the login captcha — click to require it' : 'This user must solve the captcha — click to exempt them'}
                  onClick={() => void toggleExempt(u)}
                >
                  {u.captchaExempt ? '✓ Exempt' : 'Required'}
                </button>
              </td>
              <td style={{ textAlign: 'right' }}>
                {u.id !== me?.id && <button className="btn small danger" onClick={() => setDeleting(u)}>Delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Add user</h3>
      <div className="row wrap">
        <input style={{ width: 140 }} type="text" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input style={{ width: 160 }} type="password" placeholder="password (min 6)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <select style={{ width: 150 }} value={role} onChange={(e) => setRole(e.target.value as Role)} title="Role determines what the user can do">
          <option value="admin">{ROLE_LABELS.admin}</option>
          <option value="moderator">{ROLE_LABELS.moderator}</option>
          <option value="npc">{ROLE_LABELS.npc}</option>
        </select>
        <label className="row" style={{ gap: 5, cursor: 'pointer' }} title="Allowlist this user to skip the login captcha">
          <input type="checkbox" checked={captchaExempt} onChange={(e) => setCaptchaExempt(e.target.checked)} /> no captcha
        </label>
        <button className="btn primary" disabled={!username || password.length < 6} onClick={() => void add()}>Add</button>
      </div>
      {deleting && (
        <Confirm message={`Delete user "${deleting.username}"?`} onYes={() => void remove(deleting)} onNo={() => setDeleting(null)} />
      )}
    </div>
  );
}
