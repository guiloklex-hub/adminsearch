import { api } from '@web/lib/api.ts';
import type { ReactNode } from 'react';

const NAV = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'machines', label: 'Máquinas' },
  { id: 'findings', label: 'Achados' },
  { id: 'events', label: 'Eventos' },
  { id: 'remediation', label: 'A executar' },
  { id: 'severity-policy', label: 'Política de Severidade' },
  { id: 'institutional-groups', label: 'Grupos Institucionais' },
  { id: 'ad-directory', label: 'AD — Grupos e Usuários' },
  { id: 'settings', label: 'Configurações' },
] as const;

export type Route = (typeof NAV)[number]['id'];

export function Layout({
  current,
  onNavigate,
  username,
  children,
}: {
  current: Route;
  onNavigate: (route: Route) => void;
  username: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <aside
        style={{
          width: 240,
          background: 'var(--color-surface)',
          borderRight: '1px solid var(--color-border)',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: 0.5 }}>adminsearch</div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              style={{
                textAlign: 'left',
                padding: '8px 12px',
                borderRadius: 8,
                border: 'none',
                background: current === item.id ? 'var(--color-surface-2)' : 'transparent',
                color: current === item.id ? 'var(--color-text)' : 'var(--color-muted)',
                fontWeight: current === item.id ? 600 : 400,
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div style={{ marginTop: 'auto', fontSize: 12, color: 'var(--color-muted)' }}>
          <div>Conectado como</div>
          <div style={{ color: 'var(--color-text)', fontWeight: 600 }}>{username}</div>
          <button
            type="button"
            onClick={async () => {
              await api('/api/v1/auth/logout', { method: 'POST' });
              window.location.reload();
            }}
            style={{
              marginTop: 8,
              padding: '4px 8px',
              border: '1px solid var(--color-border)',
              background: 'transparent',
              color: 'var(--color-muted)',
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            Sair
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, overflow: 'auto', padding: 24 }}>{children}</main>
    </div>
  );
}

export { NAV };
