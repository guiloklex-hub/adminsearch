import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, buildQuery } from '@web/lib/api.ts';
import { Pagination } from './Pagination.tsx';
import { SeverityBadge } from './SeverityBadge.tsx';
import { tableStyle, tdStyle, thStyle } from './Dashboard.tsx';

interface MachineRow {
  id: string;
  dnsHostName: string;
  netBiosName: string;
  domain: string | null;
  osCaption: string | null;
  osVersion: string | null;
  tags: string[] | null;
  lastSeenAt: string;
  lastLoggedUser: string | null;
  maxSeverity: string | null;
  adminCount: number;
}

export function MachinesPage({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [severity, setSeverity] = useState<string[]>([]);
  const [staleDays, setStaleDays] = useState<number | ''>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Volta pra página 1 quando filtros mudam
  useEffect(() => {
    setPage(1);
  }, [q, severity, staleDays, pageSize]);

  const { data, isLoading } = useQuery({
    queryKey: ['machines', { q, severity, staleDays, page, pageSize }],
    queryFn: () =>
      api<{ items: MachineRow[]; total: number; page: number; pageSize: number }>(
        `/api/v1/machines${buildQuery({
          q,
          severity,
          staleDays: staleDays === '' ? undefined : staleDays,
          page,
          pageSize,
        })}`,
      ),
  });

  const toggleSev = (s: string) => {
    setSeverity((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: 0 }}>Máquinas</h1>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          placeholder="Buscar por hostname, NetBIOS ou último usuário..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{
            padding: '8px 12px',
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            color: 'var(--color-text)',
            minWidth: 360,
          }}
        />

        <div style={{ display: 'flex', gap: 6 }}>
          {(['critical', 'high', 'medium', 'low', 'info'] as const).map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => toggleSev(s)}
              style={{
                padding: '4px 10px',
                borderRadius: 999,
                border: '1px solid var(--color-border)',
                background: severity.includes(s) ? 'var(--color-surface-2)' : 'transparent',
                color: 'var(--color-text)',
                fontSize: 12,
              }}
            >
              ≥ <SeverityBadge value={s} />
            </button>
          ))}
        </div>

        <label style={{ fontSize: 12, color: 'var(--color-muted)' }}>
          Silenciosa há dias:
          <input
            type="number"
            min={1}
            value={staleDays}
            onChange={(e) => setStaleDays(e.target.value === '' ? '' : Number(e.target.value))}
            style={{
              marginLeft: 6,
              padding: '4px 6px',
              width: 70,
              background: 'var(--color-surface-2)',
              border: '1px solid var(--color-border)',
              borderRadius: 4,
              color: 'var(--color-text)',
            }}
          />
        </label>
      </div>

      <div
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          padding: 8,
        }}
      >
        {isLoading ? (
          <div style={{ padding: 16 }}>Carregando...</div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Host</th>
                <th style={thStyle}>Domínio</th>
                <th style={thStyle}>SO</th>
                <th style={thStyle}>Último scan</th>
                <th style={thStyle}>Último user</th>
                <th style={thStyle}>Severidade</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Admins</th>
                <th style={thStyle}>Tags</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => onSelect(m.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>{m.dnsHostName}</div>
                    <div style={{ color: 'var(--color-muted)', fontSize: 12 }}>{m.netBiosName}</div>
                  </td>
                  <td style={tdStyle}>{m.domain ?? '—'}</td>
                  <td style={tdStyle}>{m.osCaption ?? '—'}</td>
                  <td style={tdStyle}>{new Date(m.lastSeenAt).toLocaleString('pt-BR')}</td>
                  <td style={tdStyle}>{m.lastLoggedUser ?? '—'}</td>
                  <td style={tdStyle}>
                    <SeverityBadge value={m.maxSeverity} />
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                    {m.adminCount}
                  </td>
                  <td style={tdStyle}>
                    {(m.tags ?? []).map((t) => (
                      <span
                        key={t}
                        style={{
                          background: 'var(--color-surface-2)',
                          padding: '2px 6px',
                          borderRadius: 4,
                          fontSize: 11,
                          marginRight: 4,
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ ...tdStyle, textAlign: 'center', color: 'var(--color-muted)' }}>
                    Nenhuma máquina encontrada.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {data && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={data.total}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      )}
    </div>
  );
}
