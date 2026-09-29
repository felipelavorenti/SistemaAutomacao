import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { get, onAuthProblem, post, ROLE_LABEL, type Me } from './api';
import { AccountPage } from './pages/AccountPage';
import { AuditPage } from './pages/AuditPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { ClientsPage } from './pages/ClientsPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { DbCommandsPage } from './pages/DbCommandsPage';
import { ErpPage, ErpsPage } from './pages/ErpsPage';
import { ExecutionPage } from './pages/ExecutionPage';
import { ExecutionsPage } from './pages/ExecutionsPage';
import { FoldersPage } from './pages/FoldersPage';
import { LoginPage } from './pages/LoginPage';
import { UsersPage } from './pages/UsersPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { EditorPage } from './editor/EditorPage';
import { Icon, Logo } from './components/icons';

interface AuthState {
  me: Me;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useMe(): Me {
  return useContext(AuthContext)!.me;
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const navigate = useNavigate();

  const reload = useCallback(async () => {
    try {
      setMe(await get<Me>('/auth/me'));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void reload();
    onAuthProblem((status, code) => {
      if (status === 401) setMe(null);
      if (code === 'must_change_password') navigate('/trocar-senha');
    });
  }, [reload, navigate]);

  if (me === undefined) return <div className="center muted">Carregando…</div>;
  if (me === null) return <LoginPage onLogin={reload} />;
  if (me.mustChangePassword) return <ChangePasswordPage forced onDone={reload} />;

  return (
    <AuthContext.Provider value={{ me, reload }}>
      <Routes>
        <Route path="/fluxos/:id" element={<EditorPage />} />
        <Route
          path="*"
          element={
            <Layout>
              <Routes>
                <Route path="/" element={<Navigate to="/fluxos" replace />} />
                <Route path="/fluxos" element={<WorkflowsPage />} />
                <Route path="/execucoes" element={<ExecutionsPage />} />
                <Route path="/execucoes/:id" element={<ExecutionPage />} />
                <Route path="/conexoes" element={<ConnectionsPage />} />
                <Route path="/erps" element={<ErpsPage />} />
                <Route path="/erps/:id" element={<ErpPage />} />
                <Route path="/comandos-sql" element={<DbCommandsPage />} />
                <Route path="/clientes" element={<ClientsPage />} />
                <Route path="/pastas" element={<FoldersPage />} />
                <Route path="/usuarios" element={<UsersPage />} />
                <Route path="/auditoria" element={<AuditPage />} />
                <Route path="/conta" element={<AccountPage />} />
                <Route path="/trocar-senha" element={<ChangePasswordPage onDone={reload} />} />
                <Route path="*" element={<p>Página não encontrada.</p>} />
              </Routes>
            </Layout>
          }
        />
      </Routes>
    </AuthContext.Provider>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const { me, reload } = useContext(AuthContext)!;
  const logout = async () => {
    await post('/auth/logout');
    await reload();
  };
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <span>Info8n</span>
        </div>
        <nav>
          <NavItem to="/fluxos" icon="flows" label="Fluxos" />
          <NavItem to="/execucoes" icon="executions" label="Execuções" />
          <NavItem to="/conexoes" icon="connections" label="Conexões" />
          <NavItem to="/erps" icon="erp" label="APIs dos ERPs" />
          <NavItem to="/comandos-sql" icon="sql" label="Comandos SQL" />
          <NavItem to="/clientes" icon="clients" label="Clientes" />
          {me.permissions.admin && (
            <>
              <div className="nav-section">Administração</div>
              <NavItem to="/usuarios" icon="users" label="Usuários" />
              <NavItem to="/pastas" icon="folders" label="Pastas" />
              <NavItem to="/auditoria" icon="audit" label="Auditoria" />
            </>
          )}
        </nav>
        <div className="sidebar-footer">
          <NavLink to="/conta" className="user-link">
            <span className="avatar">{initials(me.name)}</span>
            <span className="user-text">
              <strong>{me.name}</strong>
              <span className="muted small">{ROLE_LABEL[me.role]}</span>
            </span>
          </NavLink>
          <button className="icon" onClick={logout} title="Sair" aria-label="Sair">
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

function NavItem({ to, icon, label }: { to: string; icon: string; label: string }) {
  return (
    <NavLink to={to}>
      <Icon name={icon} />
      {label}
    </NavLink>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
