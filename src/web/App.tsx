import { useEffect, useState } from 'react';
import { AdDirectoryPage } from './components/AdDirectoryPage.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { EventsPage } from './components/EventsPage.tsx';
import { FindingsPage } from './components/FindingsPage.tsx';
import { InstitutionalGroupsPage } from './components/InstitutionalGroupsPage.tsx';
import { Layout, type Route } from './components/Layout.tsx';
import { LoginPage } from './components/LoginPage.tsx';
import { MachineDetail } from './components/MachineDetail.tsx';
import { MachinesPage } from './components/MachinesPage.tsx';
import { RemediationPage } from './components/RemediationPage.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { SeverityPolicyPage } from './components/SeverityPolicyPage.tsx';
import { ApiError, api } from './lib/api.ts';

interface SessionState {
  status: 'loading' | 'login' | 'authed';
  setupRequired: boolean;
  username: string;
}

export function App() {
  const [session, setSession] = useState<SessionState>({
    status: 'loading',
    setupRequired: false,
    username: '',
  });
  const [route, setRoute] = useState<Route>('dashboard');
  const [selectedMachine, setSelectedMachine] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await api<{ username: string }>('/api/v1/auth/me');
        if (alive) setSession({ status: 'authed', setupRequired: false, username: me.username });
      } catch (err) {
        const setup = await api<{ setupRequired: boolean }>('/api/v1/auth/setup-required').catch(
          () => ({ setupRequired: false }),
        );
        if (alive) {
          if (err instanceof ApiError && err.status === 401) {
            setSession({ status: 'login', setupRequired: setup.setupRequired, username: '' });
          } else {
            setSession({ status: 'login', setupRequired: setup.setupRequired, username: '' });
          }
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (session.status === 'loading') {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-muted)',
        }}
      >
        Carregando...
      </div>
    );
  }

  if (session.status === 'login') {
    return (
      <LoginPage
        setupRequired={session.setupRequired}
        onAuthenticated={async () => {
          const me = await api<{ username: string }>('/api/v1/auth/me');
          setSession({ status: 'authed', setupRequired: false, username: me.username });
        }}
      />
    );
  }

  const handleNavigate = (r: Route) => {
    setSelectedMachine(null);
    setRoute(r);
  };

  return (
    <Layout current={route} onNavigate={handleNavigate} username={session.username}>
      {route === 'dashboard' && <Dashboard />}
      {route === 'machines' && !selectedMachine && (
        <MachinesPage onSelect={(id) => setSelectedMachine(id)} />
      )}
      {route === 'machines' && selectedMachine && (
        <MachineDetail id={selectedMachine} onBack={() => setSelectedMachine(null)} />
      )}
      {route === 'findings' && <FindingsPage />}
      {route === 'events' && <EventsPage />}
      {route === 'remediation' && <RemediationPage />}
      {route === 'severity-policy' && <SeverityPolicyPage />}
      {route === 'institutional-groups' && <InstitutionalGroupsPage />}
      {route === 'ad-directory' && <AdDirectoryPage />}
      {route === 'settings' && <SettingsPage />}
    </Layout>
  );
}
