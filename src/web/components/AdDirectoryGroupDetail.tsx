import { useQuery } from '@tanstack/react-query';
import { api, buildQuery } from '@web/lib/api.ts';
import { useEffect, useState } from 'react';
import { tableStyle, tdStyle, thStyle } from './Dashboard.tsx';
import { Pagination } from './Pagination.tsx';

interface MemberRow {
  sid: string;
  name: string;
  sam_account_name: string | null;
  user_principal_name: string | null;
  email: string | null;
  department: string | null;
  title: string | null;
  enabled: boolean | null;
  is_service_account: boolean;
  last_logon: string | null;
  is_direct: boolean;
}

export function AdDirectoryGroupDetail({
  sid,
  onClose,
}: {
  sid: string;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [onlyDirect, setOnlyDirect] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    setPage(1);
  }, [q, onlyEnabled, onlyDirect, pageSize]);

  const { data, isLoading } = useQuery({
    queryKey: [
      'ad-directory',
      'group-members',
      sid,
      { q, onlyEnabled, onlyDirect, page, pageSize },
    ],
    queryFn: () =>
      api<{ items: MemberRow[]; total: number }>(
        `/api/v1/ad-directory/groups/${encodeURIComponent(sid)}/members${buildQuery({
          q,
          onlyEnabled,
          onlyDirect,
          page,
          pageSize,
        })}`,
      ),
  });

  // ESC fecha
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
            <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>Membros do grupo</div>
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

        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            paddingBottom: 4,
          }}
        >
          <input
            placeholder="Buscar membro..."
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
              checked={onlyEnabled}
              onChange={(e) => setOnlyEnabled(e.target.checked)}
            />
            Só habilitados
          </label>
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
                <th style={thStyle}>Usuário</th>
                <th style={thStyle}>SAM</th>
                <th style={thStyle}>Email</th>
                <th style={thStyle}>Tipo</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((m) => (
                <tr key={m.sid}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>{m.name}</div>
                    {m.department && (
                      <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>
                        {m.department}
                      </div>
                    )}
                    {m.enabled === false && (
                      <div
                        style={{ fontSize: 10, color: 'var(--color-critical)', fontWeight: 600 }}
                      >
                        DESABILITADO
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>{m.sam_account_name ?? '—'}</td>
                  <td style={tdStyle}>{m.email ?? '—'}</td>
                  <td style={{ ...tdStyle, fontSize: 11 }}>
                    {m.is_direct ? 'direto' : 'herdado'}
                    {m.is_service_account && (
                      <div style={{ color: 'var(--color-muted)' }}>service account</div>
                    )}
                  </td>
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    style={{ ...tdStyle, textAlign: 'center', color: 'var(--color-muted)' }}
                  >
                    Nenhum membro.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {data && data.total > pageSize && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={data.total}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            pageSizeOptions={[25, 50, 100]}
          />
        )}
      </aside>
    </>
  );
}
