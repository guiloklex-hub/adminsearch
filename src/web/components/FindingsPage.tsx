import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, buildQuery } from '@web/lib/api.ts';
import { RemediationModal, type RemediationTarget } from './RemediationModal.tsx';
import { SeverityBadge } from './SeverityBadge.tsx';
import { tableStyle, tdStyle, thStyle } from './Dashboard.tsx';

type Tab = 'by-machine' | 'by-user' | 'by-group';

const SEV_OPTIONS = ['critical', 'high', 'medium', 'low', 'info'] as const;
const SOURCE_OPTIONS = ['AD_USER', 'LOCAL_USER', 'WELL_KNOWN', 'ORPHAN_SID'] as const;

export function FindingsPage() {
  const [tab, setTab] = useState<Tab>('by-machine');
  const [q, setQ] = useState('');
  const [severity, setSeverity] = useState<string[]>(['critical', 'high']);
  const [source, setSource] = useState<string[]>([]);
  const [hideExceptions, setHideExceptions] = useState(true);
  const [onlyOrphans, setOnlyOrphans] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Achados</h1>
        <a
          href={`/api/v1/export/findings.csv${buildQuery({ severity, source, hideExceptions })}`}
          style={{
            background: 'var(--color-accent)',
            color: 'white',
            padding: '6px 12px',
            borderRadius: 6,
            fontSize: 13,
            textDecoration: 'none',
          }}
        >
          Exportar CSV
        </a>
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        {(['by-machine', 'by-user', 'by-group'] as const).map((t) => (
          <button
            type="button"
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '6px 12px',
              background: tab === t ? 'var(--color-surface-2)' : 'transparent',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
              borderRadius: 6,
            }}
          >
            {t === 'by-machine' ? 'Por máquina' : t === 'by-user' ? 'Por usuário' : 'Por grupo herdado'}
          </button>
        ))}
      </div>

      {tab === 'by-machine' && (
        <FindingsByMachine
          q={q}
          setQ={setQ}
          severity={severity}
          setSeverity={setSeverity}
          source={source}
          setSource={setSource}
          hideExceptions={hideExceptions}
          setHideExceptions={setHideExceptions}
          onlyOrphans={onlyOrphans}
          setOnlyOrphans={setOnlyOrphans}
        />
      )}
      {tab === 'by-user' && <FindingsByUser />}
      {tab === 'by-group' && <FindingsByGroup />}
    </div>
  );
}

interface Finding {
  id: string;
  machineId: string;
  hostName: string;
  sid: string;
  name: string | null;
  source: string;
  viaGroup: string | null;
  adEnabled: boolean | null;
  severity: string;
  matchedExceptionId: string | null;
  scanCollectedAt: string;
}

function FindingsByMachine(props: {
  q: string;
  setQ: (s: string) => void;
  severity: string[];
  setSeverity: (s: string[]) => void;
  source: string[];
  setSource: (s: string[]) => void;
  hideExceptions: boolean;
  setHideExceptions: (v: boolean) => void;
  onlyOrphans: boolean;
  setOnlyOrphans: (v: boolean) => void;
}) {
  const { q, setQ, severity, setSeverity, source, setSource, hideExceptions, setHideExceptions, onlyOrphans, setOnlyOrphans } = props;

  const [removeTarget, setRemoveTarget] = useState<RemediationTarget | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['findings', { q, severity, source, hideExceptions, onlyOrphans }],
    queryFn: () =>
      api<{ items: Finding[] }>(
        `/api/v1/findings${buildQuery({
          q,
          severity,
          source,
          hideExceptions,
          onlyOrphans,
          pageSize: 300,
        })}`,
      ),
  });

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16 }}>
      <aside
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          alignSelf: 'flex-start',
        }}
      >
        <input
          placeholder="Buscar..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={inputStyle}
        />

        <FilterGroup
          label="Severidade"
          options={[...SEV_OPTIONS]}
          selected={severity}
          onToggle={(v) =>
            setSeverity(severity.includes(v) ? severity.filter((x) => x !== v) : [...severity, v])
          }
          renderOption={(v) => <SeverityBadge value={v} />}
        />

        <FilterGroup
          label="Origem"
          options={[...SOURCE_OPTIONS]}
          selected={source}
          onToggle={(v) =>
            setSource(source.includes(v) ? source.filter((x) => x !== v) : [...source, v])
          }
        />

        <Toggle
          label="Ocultar exceções"
          value={hideExceptions}
          onChange={setHideExceptions}
        />
        <Toggle label="Só SIDs órfãos" value={onlyOrphans} onChange={setOnlyOrphans} />
      </aside>

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
                <th style={thStyle}>Usuário</th>
                <th style={thStyle}>Origem</th>
                <th style={thStyle}>Via grupo</th>
                <th style={thStyle}>AD habilitado</th>
                <th style={thStyle}>Severidade</th>
                <th style={thStyle}>SID</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {data?.items.map((it) => {
                const canRemediate =
                  !it.matchedExceptionId &&
                  ['critical', 'high', 'medium'].includes(it.severity) &&
                  it.source !== 'WELL_KNOWN';
                return (
                  <tr key={it.id}>
                    <td style={tdStyle}>{it.hostName}</td>
                    <td style={tdStyle}>{it.name ?? '—'}</td>
                    <td style={tdStyle}>{it.source}</td>
                    <td style={tdStyle}>{it.viaGroup ?? '—'}</td>
                    <td style={tdStyle}>
                      {it.adEnabled === null ? '—' : it.adEnabled ? 'sim' : 'NÃO'}
                    </td>
                    <td style={tdStyle}>
                      <SeverityBadge value={it.severity} />
                    </td>
                    <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 11 }}>{it.sid}</td>
                    <td style={tdStyle}>
                      {canRemediate && (
                        <button
                          type="button"
                          onClick={() =>
                            setRemoveTarget({
                              machineId: it.machineId,
                              hostName: it.hostName,
                              sid: it.sid,
                              name: it.name,
                              severity: it.severity,
                              source: it.source,
                              viaGroup: it.viaGroup,
                            })
                          }
                          style={{
                            padding: '2px 8px',
                            background: 'transparent',
                            border: '1px solid var(--color-border)',
                            color: 'var(--color-critical)',
                            borderRadius: 4,
                            fontSize: 11,
                          }}
                        >
                          Remover
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {data && data.items.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ ...tdStyle, textAlign: 'center', color: 'var(--color-muted)' }}>
                    Nenhum achado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <RemediationModal
        target={removeTarget}
        onClose={() => setRemoveTarget(null)}
        onPlanned={() => setRemoveTarget(null)}
      />
    </div>
  );
}

function FindingsByUser() {
  const { data, isLoading } = useQuery({
    queryKey: ['findings', 'by-user'],
    queryFn: () =>
      api<{
        items: Array<{
          sid: string;
          name: string;
          sam_account_name: string | null;
          department: string | null;
          machine_count: number;
          critical_count: number;
          high_count: number;
        }>;
      }>('/api/v1/findings/by-user?limit=200'),
  });
  if (isLoading) return <div>Carregando...</div>;
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        padding: 8,
      }}
    >
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Usuário</th>
            <th style={thStyle}>SAM</th>
            <th style={thStyle}>Departamento</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Máquinas</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Críticos</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Altos</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((u) => (
            <tr key={u.sid}>
              <td style={tdStyle}>{u.name}</td>
              <td style={tdStyle}>{u.sam_account_name ?? '—'}</td>
              <td style={tdStyle}>{u.department ?? '—'}</td>
              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>{u.machine_count}</td>
              <td style={{ ...tdStyle, textAlign: 'right' }}>{u.critical_count}</td>
              <td style={{ ...tdStyle, textAlign: 'right' }}>{u.high_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FindingsByGroup() {
  const { data, isLoading } = useQuery({
    queryKey: ['findings', 'by-group'],
    queryFn: () =>
      api<{
        items: Array<{
          group_name: string;
          group_sid: string;
          user_count: number;
          machine_count: number;
        }>;
      }>('/api/v1/findings/by-group?limit=200'),
  });
  if (isLoading) return <div>Carregando...</div>;
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        padding: 8,
      }}
    >
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Grupo herdado</th>
            <th style={thStyle}>SID</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Usuários únicos</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Máquinas alcançadas</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((g) => (
            <tr key={g.group_sid}>
              <td style={tdStyle}>{g.group_name}</td>
              <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 11 }}>{g.group_sid}</td>
              <td style={{ ...tdStyle, textAlign: 'right' }}>{g.user_count}</td>
              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>{g.machine_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FilterGroup({
  label,
  options,
  selected,
  onToggle,
  renderOption,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  renderOption?: (v: string) => React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      {options.map((o) => (
        <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={selected.includes(o)}
            onChange={() => onToggle(o)}
          />
          {renderOption ? renderOption(o) : o}
        </label>
      ))}
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  color: 'var(--color-text)',
  fontSize: 13,
};
