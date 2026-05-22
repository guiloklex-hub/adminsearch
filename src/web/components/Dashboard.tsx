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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <h1 style={{ margin: 0 }}>Dashboard</h1>

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
        <Card title="Eventos (24h)" value={c.events_24h} />
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
