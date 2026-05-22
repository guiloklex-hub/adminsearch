import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, api, buildQuery } from '@web/lib/api.ts';
import { Pagination } from './Pagination.tsx';
import { tableStyle, tdStyle, thStyle } from './Dashboard.tsx';

interface Action {
  id: string;
  machineId: string;
  hostName: string;
  targetSid: string;
  targetName: string | null;
  targetSource: string | null;
  viaGroup: string | null;
  status: string;
  plannedBy: string;
  plannedAt: string;
  plannedReason: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  dispatchedAt: string | null;
  executedAt: string | null;
  executionResult: string | null;
  executionError: string | null;
}

const STATUS_GROUPS = {
  planned: ['planned'],
  pending: ['confirmed', 'dispatched'],
  history: ['executed', 'failed', 'refused', 'cancelled'],
} as const;

export function RemediationPage() {
  const [tab, setTab] = useState<'planned' | 'pending' | 'history'>('planned');
  const statuses = STATUS_GROUPS[tab];
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    setPage(1);
  }, [tab, pageSize]);

  const { data, isLoading } = useQuery({
    queryKey: ['remediation', tab, page, pageSize],
    queryFn: () =>
      api<{ items: Action[]; total: number }>(
        `/api/v1/remediation${buildQuery({ status: [...statuses], page, pageSize, sinceDays: 90 })}`,
      ),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: 0 }}>A executar</h1>
      <div style={{ color: 'var(--color-muted)', fontSize: 13 }}>
        Fluxo: <strong>Planejada</strong> → revisar → confirmar → <strong>Aguardando execução</strong>{' '}
        → próximo phone-home do agente → <strong>Histórico</strong>.
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {(['planned', 'pending', 'history'] as const).map((t) => (
          <button
            type="button"
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '6px 14px',
              background: tab === t ? 'var(--color-surface-2)' : 'transparent',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
              borderRadius: 6,
            }}
          >
            {t === 'planned' ? 'Planejadas' : t === 'pending' ? 'Aguardando execução' : 'Histórico'}
            {data && tab === t ? ` (${data.items.length})` : ''}
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
        ) : tab === 'planned' ? (
          <PlannedTable items={data?.items ?? []} />
        ) : tab === 'pending' ? (
          <PendingTable items={data?.items ?? []} />
        ) : (
          <HistoryTable items={data?.items ?? []} />
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

function PlannedTable({ items }: { items: Action[] }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const confirmM = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/remediation/${id}/confirm`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['remediation'] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro'),
  });

  const cancelM = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api(`/api/v1/remediation/${id}/cancel`, { method: 'POST', json: { reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['remediation'] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro'),
  });

  return (
    <>
      {error && (
        <div style={{ padding: 12, color: 'var(--color-critical)', fontSize: 13 }}>{error}</div>
      )}
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Host</th>
            <th style={thStyle}>Alvo</th>
            <th style={thStyle}>Origem</th>
            <th style={thStyle}>Motivo</th>
            <th style={thStyle}>Planejada por</th>
            <th style={thStyle}>Quando</th>
            <th style={thStyle} />
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td style={tdStyle}>{it.hostName}</td>
              <td style={tdStyle}>
                <div>{it.targetName ?? '—'}</div>
                <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--color-muted)' }}>
                  {it.targetSid}
                </div>
              </td>
              <td style={tdStyle}>
                {it.targetSource ?? '—'}
                {it.viaGroup ? (
                  <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>via {it.viaGroup}</div>
                ) : null}
              </td>
              <td style={tdStyle}>{it.plannedReason ?? '—'}</td>
              <td style={tdStyle}>{it.plannedBy}</td>
              <td style={tdStyle}>{new Date(it.plannedAt).toLocaleString('pt-BR')}</td>
              <td style={{ ...tdStyle, display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  disabled={confirmM.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Confirmar remoção de ${it.targetName ?? it.targetSid} em ${it.hostName}?\n\nO agente vai executar no próximo phone-home (Scheduled Task diária ou execução manual via ScreenConnect).`,
                      )
                    ) {
                      confirmM.mutate(it.id);
                    }
                  }}
                  style={primaryBtn}
                >
                  Confirmar
                </button>
                <button
                  type="button"
                  disabled={cancelM.isPending}
                  onClick={() => {
                    const reason = window.prompt('Motivo do cancelamento:');
                    if (reason && reason.trim()) cancelM.mutate({ id: it.id, reason: reason.trim() });
                  }}
                  style={dangerBtn}
                >
                  Cancelar
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={7} style={{ ...tdStyle, color: 'var(--color-muted)', textAlign: 'center' }}>
                Nenhuma ação planejada.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function PendingTable({ items }: { items: Action[] }) {
  const qc = useQueryClient();
  const cancelM = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api(`/api/v1/remediation/${id}/cancel`, { method: 'POST', json: { reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['remediation'] }),
  });

  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={thStyle}>Host</th>
          <th style={thStyle}>Alvo</th>
          <th style={thStyle}>Status</th>
          <th style={thStyle}>Confirmada por</th>
          <th style={thStyle}>Confirmada em</th>
          <th style={thStyle}>Entregue ao agente</th>
          <th style={thStyle} />
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={it.id}>
            <td style={tdStyle}>{it.hostName}</td>
            <td style={tdStyle}>
              <div>{it.targetName ?? '—'}</div>
              <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--color-muted)' }}>
                {it.targetSid}
              </div>
            </td>
            <td style={tdStyle}>
              <StatusBadge status={it.status} />
            </td>
            <td style={tdStyle}>{it.confirmedBy ?? '—'}</td>
            <td style={tdStyle}>
              {it.confirmedAt ? new Date(it.confirmedAt).toLocaleString('pt-BR') : '—'}
            </td>
            <td style={tdStyle}>
              {it.dispatchedAt ? new Date(it.dispatchedAt).toLocaleString('pt-BR') : '—'}
            </td>
            <td style={tdStyle}>
              <button
                type="button"
                onClick={() => {
                  const reason = window.prompt('Motivo do cancelamento:');
                  if (reason && reason.trim()) cancelM.mutate({ id: it.id, reason: reason.trim() });
                }}
                style={dangerBtn}
              >
                Cancelar
              </button>
            </td>
          </tr>
        ))}
        {items.length === 0 && (
          <tr>
            <td colSpan={7} style={{ ...tdStyle, color: 'var(--color-muted)', textAlign: 'center' }}>
              Nada aguardando execução.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function HistoryTable({ items }: { items: Action[] }) {
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={thStyle}>Host</th>
          <th style={thStyle}>Alvo</th>
          <th style={thStyle}>Status</th>
          <th style={thStyle}>Resultado</th>
          <th style={thStyle}>Executado em</th>
          <th style={thStyle}>Detalhes</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={it.id}>
            <td style={tdStyle}>{it.hostName}</td>
            <td style={tdStyle}>
              <div>{it.targetName ?? '—'}</div>
              <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--color-muted)' }}>
                {it.targetSid}
              </div>
            </td>
            <td style={tdStyle}>
              <StatusBadge status={it.status} />
            </td>
            <td style={tdStyle}>{it.executionResult ?? it.status}</td>
            <td style={tdStyle}>
              {it.executedAt ? new Date(it.executedAt).toLocaleString('pt-BR') : '—'}
            </td>
            <td style={{ ...tdStyle, fontSize: 12, color: 'var(--color-muted)' }}>
              {it.executionError ?? it.cancelReason ?? '—'}
            </td>
          </tr>
        ))}
        {items.length === 0 && (
          <tr>
            <td colSpan={6} style={{ ...tdStyle, color: 'var(--color-muted)', textAlign: 'center' }}>
              Histórico vazio (últimos 90 dias).
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    planned: { bg: 'rgba(212, 181, 65, 0.18)', fg: '#e6cf6b' },
    confirmed: { bg: 'rgba(91, 155, 229, 0.18)', fg: '#7ab2ff' },
    dispatched: { bg: 'rgba(91, 155, 229, 0.18)', fg: '#7ab2ff' },
    executed: { bg: 'rgba(121, 210, 138, 0.18)', fg: '#79d28a' },
    failed: { bg: 'rgba(229, 69, 69, 0.18)', fg: '#ff7a7a' },
    refused: { bg: 'rgba(224, 138, 60, 0.18)', fg: '#f0a262' },
    cancelled: { bg: 'rgba(108, 116, 136, 0.18)', fg: '#a4abbf' },
  };
  const c = colors[status] ?? colors.cancelled;
  if (!c) return <span>{status}</span>;
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: '4px 10px',
  background: 'var(--color-accent)',
  color: 'white',
  border: 'none',
  borderRadius: 4,
  fontSize: 12,
};

const dangerBtn: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  color: 'var(--color-critical)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  fontSize: 12,
};
