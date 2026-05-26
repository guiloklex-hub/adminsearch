import { useQuery } from '@tanstack/react-query';
import { api, buildQuery } from '@web/lib/api.ts';
import { useEffect, useState } from 'react';
import { tableStyle, tdStyle, thStyle } from './Dashboard.tsx';

interface GroupRow {
  sid: string;
  name: string;
  sam_account_name: string | null;
  description: string | null;
  scope: string | null;
  is_security: boolean | null;
  member_count: number;
  is_direct: boolean;
}

export function AdDirectoryUserDetail({
  sid,
  onClose,
}: {
  sid: string;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [onlyDirect, setOnlyDirect] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['ad-directory', 'user-groups', sid, { q, onlyDirect }],
    queryFn: () =>
      api<{ items: GroupRow[] }>(
        `/api/v1/ad-directory/users/${encodeURIComponent(sid)}/groups${buildQuery({
          q,
          onlyDirect,
        })}`,
      ),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onClose();
        }}
        role="button"
        tabIndex={-1}
        aria-label="Fechar painel"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.4)',
          zIndex: 9,
        }}
      />
      <aside
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          bottom: 0,
          width: 560,
          maxWidth: '90vw',
          background: 'var(--color-surface)',
          borderLeft: '1px solid var(--color-border)',
          padding: 16,
          overflowY: 'auto',
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>Grupos do usuário</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--color-muted)' }}>
              {sid}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '4px 10px',
              background: 'transparent',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Fechar
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            placeholder="Buscar grupo..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{
              flex: 1,
              minWidth: 200,
              padding: '6px 10px',
              background: 'var(--color-surface-2)',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              color: 'var(--color-text)',
              fontSize: 13,
            }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={onlyDirect}
              onChange={(e) => setOnlyDirect(e.target.checked)}
            />
            Só diretos
          </label>
        </div>

        {isLoading ? (
          <div style={{ padding: 16 }}>Carregando...</div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Grupo</th>
                <th style={thStyle}>Escopo</th>
                <th style={thStyle}>Tipo</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Membros</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((g) => (
                <tr key={g.sid}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>{g.name}</div>
                    {g.description && (
                      <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>
                        {g.description}
                      </div>
                    )}
                    <div
                      style={{
                        fontSize: 10,
                        color: g.is_direct ? '#79d28a' : 'var(--color-muted)',
                      }}
                    >
                      {g.is_direct ? 'membro direto' : 'herdado via aninhamento'}
                    </div>
                  </td>
                  <td style={tdStyle}>{g.scope ?? '—'}</td>
                  <td style={tdStyle}>
                    {g.is_security === null ? '—' : g.is_security ? 'segurança' : 'distribuição'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    {g.member_count.toLocaleString('pt-BR')}
                  </td>
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    style={{ ...tdStyle, textAlign: 'center', color: 'var(--color-muted)' }}
                  >
                    Nenhum grupo.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </aside>
    </>
  );
}
