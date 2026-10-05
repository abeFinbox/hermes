import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import type { User } from './types';
import { Info, useLegends } from './legends';
import { SYSTEM, useTheme } from './themes';
import Login from './pages/Login';
import Appearance from './pages/Appearance';
import Collections from './pages/Collections';
import Suites from './pages/Suites';
import SuiteEditor from './pages/SuiteEditor';
import Variables from './pages/Variables';
import Files from './pages/Files';
import Runs from './pages/Runs';
import RunDetail from './pages/RunDetail';
import Hera from './pages/Hera';
import HeraDetail from './pages/HeraDetail';
import Settings from './pages/Settings';
import Docs from './pages/Docs';
import TopbarMetrics from './components/TopbarMetrics';
import EngineIndicator from './components/EngineIndicator';
import RouteFX from './components/RouteFX';
import { permsFor, ROLE_LABELS } from './perms';

interface AuthCtx {
  user: User | null;
  setUser: (u: User | null) => void;
}
const Ctx = createContext<AuthCtx>({ user: null, setUser: () => {} });
export const useAuth = () => useContext(Ctx);

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const location = useLocation();

  useEffect(() => {
    api.get<User>('/api/auth/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
    const onUnauthorized = () => setUser(null);
    window.addEventListener('ats:unauthorized', onUnauthorized);
    return () => window.removeEventListener('ats:unauthorized', onUnauthorized);
  }, []);

  if (checking) return null;

  return (
    <Ctx.Provider value={{ user, setUser }}>
      {user ? <Shell /> : <Login />}
    </Ctx.Provider>
  );
}

function Shell() {
  const { user, setUser } = useAuth();
  const { on, toggle } = useLegends();
  const { selection, setSelection, allThemes } = useTheme();
  const navigate = useNavigate();
  const perms = permsFor(user?.role, user?.isAdmin);

  const logout = async () => {
    await api.post('/api/auth/logout');
    setUser(null);
    navigate('/');
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          ⚡ Hermes<span className="tm">™</span><Info k="app.name" />
        </div>
        <nav>
          <NavLink to="/collections">Collections<Info k="nav.collections" /></NavLink>
          <NavLink to="/suites">Suites<Info k="nav.suites" /></NavLink>
          <NavLink to="/variables">Variables<Info k="nav.variables" /></NavLink>
          <NavLink to="/files">Files<Info k="nav.files" /></NavLink>
          <NavLink to="/runs">Runs<Info k="nav.runs" /></NavLink>
          {perms.canAppearance && <NavLink to="/appearance">Appearance<Info k="nav.appearance" /></NavLink>}
          <NavLink to="/settings">Settings<Info k="nav.settings" /></NavLink>
          {perms.canViewDocs && <NavLink to="/docs">Docs<Info k="nav.docs" /></NavLink>}
        </nav>
        <div className="spacer" />
        <div className="whoami">
          Signed in as <b>{user!.username}</b> <span className={`role-tag ${user!.role}`}>{ROLE_LABELS[user!.role]}</span>
          <br />
          <button className="btn small mt" onClick={logout}>Log out</button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <div className="title">Hermes — API test suite builder</div>
          <EngineIndicator />
          <TopbarMetrics />
          <select style={{ width: 150 }} value={selection} onChange={(e) => setSelection(e.target.value)}
            title="Quick theme switch — manage themes on the Appearance page">
            <option value={SYSTEM}>System theme</option>
            {allThemes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <label className="row" style={{ gap: 6, cursor: 'pointer' }} title="Show ⓘ help badges next to every function">
            <input type="checkbox" checked={on} onChange={toggle} />
            Legends
          </label>
        </div>
        <div className="content">
          <RouteFX />
          <div className="route-page" key={location.pathname}>
          <Routes location={location}>
            <Route path="/" element={<Navigate to="/suites" replace />} />
            <Route path="/collections" element={<Collections />} />
            <Route path="/suites" element={<Suites />} />
            <Route path="/suites/:id" element={<SuiteEditor />} />
            <Route path="/variables" element={<Variables />} />
            <Route path="/files" element={<Files />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/hera" element={perms.canLoadTest ? <Hera /> : <Navigate to="/suites" replace />} />
            <Route path="/hera/:id" element={perms.canLoadTest ? <HeraDetail /> : <Navigate to="/suites" replace />} />
            <Route path="/appearance" element={perms.canAppearance ? <Appearance /> : <Navigate to="/suites" replace />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/docs" element={perms.canViewDocs ? <Docs /> : <Navigate to="/suites" replace />} />
            <Route path="*" element={<Navigate to="/suites" replace />} />
          </Routes>
          </div>
        </div>
      </div>
    </div>
  );
}
