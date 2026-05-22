import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, buildQuery } from '@web/lib/api.ts';
import { tableStyle, tdStyle, thStyle } from './Dashboard.tsx';

const KINDS = [
  'ADMIN_ADDED',
  'ADMIN_REMOVED',
  'ORPHAN_DETECTED',
  'MACHINE_RENAMED',
  'GROUP_EXPANSION_CHANGED',
] as const;

export function EventsPage() {
  const [kinds, setKinds] = useState<string[]>([]);
  const [sinceDays, setSinceDays] = useState<number>(30);

  const { data, isLoading } = useQuery({
    queryKey: ['events', { kinds, sinceDays }],
    queryFn: () =>
      api<{
        items: Array<{
          id: string;
          machineId: string;
          hostName: string;
          occurredAt: string;
          kind: string;
          sid: string | null;
          name: string | null;
          details: Record<string, unknown>;
        }>;
      }>(`/api/v1/events${buildQuery({ kind: kinds, sinceDays, pageSize: 300 })}`),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: 0 }}>Eventos</h1>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: 'var(--color-muted)' }}>
          Últimos
          <input
            type="number"
            min={1}
            value={sinceDays}
            onChange={(e) => setSinceDays(Number(e.target.value))}
            style={{
              margin: '0 6px',
              width: 70,
              padding: '4px 6px',
              background: 'var(--color-surface-2)',
              border: '1px solid var(--color-border)',
              borderRadius: 4,
              color: 'var(--color-text)',
            }}
          />
          dias
        </label>

        {KINDS.map((k) => (
          <button
            type="button"
            key={k}
            onClick={() =>
              setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))
            }
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              border: '1px solid var(--color-border)',
              background: kinds.includes(k) ? 'var(--color-surface-2)' : 'transparent',
              color: 'var(--color-text)',
              fontSize: 11,
              fontFamily: 'monospace',
            }}
          >
            {k}
          </button>
        ))}
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
                <th style={thStyle}>Quando</th>
                <th style={thStyle}>Host</th>
                <th style={thStyle}>Evento</th>
                <th style={thStyle}>Usuário/Item</th>
                <th style={thStyle}>Detalhes</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((e) => (
                <tr key={e.id}>
                  <td style={tdStyle}>{new Date(e.occurredAt).toLocaleString('pt-BR')}</td>
                  <td style={tdStyle}>{e.hostName}</td>
                  <td style={tdStyle}>
                    <code style={{ fontSize: 11 }}>{e.kind}</code>
                  </td>
                  <td style={tdStyle}>{e.name ?? e.sid ?? '—'}</td>
                  <td style={{ ...tdStyle, fontSize: 11, color: 'var(--color-muted)' }}>
                    {JSON.stringify(e.details)}
                  </td>
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ ...tdStyle, textAlign: 'center', color: 'var(--color-muted)' }}>
                    Sem eventos no período.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
