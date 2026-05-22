import { useQuery } from '@tanstack/react-query';
import ReactECharts from 'echarts-for-react';
import { api } from '@web/lib/api.ts';
import { SeverityBadge } from './SeverityBadge.tsx';

interface DashboardStats {
  cards: {
    total_machines: number;
    stale_machines: number;
    pending_scans: number;
    high_findings: number;
    critical_findings: number;
    orphan_findings: number;
    events_24h: number;
  };
  severityDistribution: { severity: string; c: number }[];
  topUsers: {
    sid: string;
    name: string;
    sam_account_name: string | null;
    machine_count: number;
  }[];
  recentEvents: {
    id: string;
    machine_id: string;
    host_name: string;
    occurred_at: string;
    kind: string;
    sid: string | null;
    name: string | null;
    details: Record<string, unknown> | null;
  }[];
}

export function Dashboard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['stats', 'dashboard'],
    queryFn: () => api<DashboardStats>('/api/v1/stats/dashboard'),
  });

  if (isLoading) return <div>Carregando...</div>;
  if (error) return <div>Erro ao carregar.</div>;
  if (!data) return null;

  const c = data.cards;

  // Eventos das últimas 24h destacados
  const eventsLast24h = data.recentEvents.filter(
    (e) => Date.now() - new Date(e.occurred_at).getTime() < 24 * 3600_000,
  );
  const addedLast24h = eventsLast24h.filter((e) => e.kind === 'ADMIN_ADDED');
  const orphanLast24h = eventsLast24h.filter((e) => e.kind === 'ORPHAN_DETECTED');
  const hasUrgent = addedLast24h.length > 0 || orphanLast24h.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <h1 style={{ margin: 0 }}>Dashboard</h1>

      {hasUrgent && (
        <div
          style={{
            background: 'rgba(229, 69, 69, 0.12)',
            border: '1px solid var(--color-critical)',
            borderRadius: 12,
            padding: 16,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <div style={{ fontSize: 22, lineHeight: 1 }}>⚠️</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: 'var(--color-critical)', marginBottom: 4 }}>
              Atividade urgente nas últimas 24h
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-text)' }}>
              {addedLast24h.length > 0 && (
                <div>
                  • <strong>{addedLast24h.length}</strong> admin(s) adicionado(s) ao grupo
                  Administrators local
                </div>
              )}
              {orphanLast24h.length > 0 && (
                <div>
                  • <strong>{orphanLast24h.length}</strong> SID órfão(s) detectado(s) (conta
                  excluída no AD mas ainda admin local)
                </div>
              )}
              <div style={{ marginTop: 6, color: 'var(--color-muted)', fontSize: 12 }}>
                Veja detalhes em <strong>Eventos</strong> ou na timeline abaixo.
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        <Card title="Máquinas inventariadas" value={c.total_machines} />
        <Card
          title="Achados críticos + altos"
          value={c.high_findings}
          accent={c.high_findings > 0 ? 'var(--color-high)' : undefined}
        />
        <Card
          title="Agentes silenciosos (>7d)"
          value={c.stale_machines}
          accent={c.stale_machines > 0 ? 'var(--color-medium)' : undefined}
        />
        <Card
          title="Eventos (24h)"
          value={c.events_24h}
          accent={addedLast24h.length > 0 ? 'var(--color-critical)' : undefined}
        />
        <Card
          title="SIDs órfãos"
          value={c.orphan_findings}
          accent={c.orphan_findings > 0 ? 'var(--color-critical)' : undefined}
        />
        <Card title="Scans pendentes de expansão" value={c.pending_scans} />
        <Card title="Apenas críticos" value={c.critical_findings} accent="var(--color-critical)" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Panel title="Distribuição por severidade">
          <ReactECharts
            style={{ height: 260 }}
            option={{
              tooltip: { trigger: 'item' },
              legend: { textStyle: { color: '#cbd2e0' }, bottom: 0 },
              series: [
                {
                  type: 'pie',
                  radius: ['45%', '70%'],
                  data: data.severityDistribution.map((d) => ({
                    name: d.severity,
                    value: d.c,
                    itemStyle: { color: severityColor(d.severity) },
                  })),
                  label: { color: '#cbd2e0' },
                },
              ],
            }}
          />
        </Panel>

        <Panel title="Top 10 — usuários AD com mais máquinas como admin">
          <ReactECharts
            style={{ height: 260 }}
            option={{
              tooltip: {},
              grid: { left: 120, top: 10, right: 20, bottom: 20 },
              xAxis: { type: 'value', axisLine: { lineStyle: { color: '#3a4254' } } },
              yAxis: {
                type: 'category',
                data: data.topUsers.slice().reverse().map((u) => u.sam_account_name ?? u.name),
                axisLabel: { color: '#cbd2e0' },
              },
              series: [
                {
                  type: 'bar',
                  data: data.topUsers.slice().reverse().map((u) => u.machine_count),
                  itemStyle: { color: '#4f8cff' },
                },
              ],
            }}
          />
        </Panel>
      </div>

      <Panel title="Atividade recente — últimos 7 dias">
        {data.recentEvents.length === 0 ? (
          <div style={{ padding: 12, color: 'var(--color-muted)' }}>
            Sem atividade recente.
          </div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Quando</th>
                <th style={thStyle}>Host</th>
                <th style={thStyle}>Evento</th>
                <th style={thStyle}>Usuário/Item</th>
                <th style={thStyle}>Contexto</th>
              </tr>
            </thead>
            <tbody>
              {data.recentEvents.map((e) => (
                <tr key={e.id}>
                  <td style={tdStyle}>{new Date(e.occurred_at).toLocaleString('pt-BR')}</td>
                  <td style={tdStyle}>{e.host_name}</td>
                  <td style={tdStyle}>
                    <EventBadge kind={e.kind} />
                  </td>
                  <td style={tdStyle}>{e.name ?? e.sid ?? '—'}</td>
                  <td style={{ ...tdStyle, fontSize: 12, color: 'var(--color-muted)' }}>
                    {formatDetails(e.details)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Usuários top com admin no parque">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Usuário</th>
              <th style={thStyle}>SAM</th>
              <th style={thStyle}>SID</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Máquinas</th>
            </tr>
          </thead>
          <tbody>
            {data.topUsers.map((u) => (
              <tr key={u.sid}>
                <td style={tdStyle}>{u.name}</td>
                <td style={tdStyle}>{u.sam_account_name ?? '—'}</td>
                <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12 }}>{u.sid}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                  {u.machine_count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <SeverityBadge value={null} />
    </div>
  );
}

function EventBadge({ kind }: { kind: string }) {
  const config: Record<string, { label: string; bg: string; fg: string }> = {
    ADMIN_ADDED: { label: '+ ADMIN ADICIONADO', bg: 'rgba(229, 69, 69, 0.18)', fg: '#ff7a7a' },
    ADMIN_REMOVED: { label: '- admin removido', bg: 'rgba(91, 155, 229, 0.18)', fg: '#7ab2ff' },
    ORPHAN_DETECTED: {
      label: '⚠ SID ÓRFÃO',
      bg: 'rgba(229, 69, 69, 0.18)',
      fg: '#ff7a7a',
    },
    MACHINE_RENAMED: { label: 'máquina renomeada', bg: 'rgba(212, 181, 65, 0.18)', fg: '#e6cf6b' },
  };
  const c = config[kind] ?? { label: kind, bg: 'var(--color-surface-2)', fg: 'var(--color-text)' };
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3,
      }}
    >
      {c.label}
    </span>
  );
}

function formatDetails(details: Record<string, unknown> | null): string {
  if (!details) return '—';
  const bits: string[] = [];
  if (details.source) bits.push(`source=${details.source}`);
  if (details.viaGroup) bits.push(`via ${details.viaGroup}`);
  if (details.severity) bits.push(`severity=${details.severity}`);
  if (details.removedBy === 'remediation') bits.push('removido por remediação');
  return bits.length > 0 ? bits.join(' · ') : JSON.stringify(details);
}

function Card({
  title,
  value,
  accent,
}: {
  title: string;
  value: number;
  accent?: string;
}) {
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        padding: 16,
      }}
    >
      <div style={{ color: 'var(--color-muted)', fontSize: 12 }}>{title}</div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: accent ?? 'var(--color-text)',
          marginTop: 4,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        padding: 16,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

function severityColor(s: string): string {
  return (
    {
      critical: '#e54545',
      high: '#e08a3c',
      medium: '#d4b541',
      low: '#5b9be5',
      info: '#6c7488',
    }[s] ?? '#6c7488'
  );
}

export const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
};

export const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  borderBottom: '1px solid var(--color-border)',
  color: 'var(--color-muted)',
  fontWeight: 500,
  fontSize: 12,
};

export const tdStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid var(--color-border)',
};
