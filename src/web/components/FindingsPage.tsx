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

interface UserRow {
  sid: string;
  name: string;
  sam_account_name: string | null;
  user_principal_name: string | null;
  email: string | null;
  department: string | null;
  title: string | null;
  ad_enabled: boolean | null;
  is_service_account: boolean;
  last_logon: string | null;
  source: string;
  has_exception: boolean;
  machine_count: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  via_group_count: number;
  direct_machine_count: number;
}

interface MachineRow {
  machine_id: string;
  host_name: string;
  domain: string | null;
  last_logged_user: string | null;
  last_seen_at: string;
  via_group: string | null;
  severity: string;
  has_exception: boolean;
}

const ALL_SOURCES = ['AD_USER', 'LOCAL_USER', 'WELL_KNOWN', 'ORPHAN_SID'] as const;
type SourceKey = (typeof ALL_SOURCES)[number];

function FindingsByUser() {
  const [q, setQ] = useState('');
  // Por padrão mostra só o que requer atenção do operador: AD_USER (usuários
  // nominais) e ORPHAN_SID (contas estranhas). Esconde LOCAL_USER e WELL_KNOWN
  // que poluem com "HOSTNAME\Administrador" e contas locais.
  const [sources, setSources] = useState<SourceKey[]>(['AD_USER', 'ORPHAN_SID']);
  const [hideServiceAccounts, setHideServiceAccounts] = useState(true);
  const [hideExceptions, setHideExceptions] = useState(true);
  const [onlyEnabled, setOnlyEnabled] = useState(true);
  const [onlyDirect, setOnlyDirect] = useState(false);
  const [expandedSid, setExpandedSid] = useState<string | null>(null);

  const toggleSource = (s: SourceKey) => {
    setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  const { data, isLoading } = useQuery({
    queryKey: [
      'findings',
      'by-user',
      { q, sources, hideServiceAccounts, hideExceptions, onlyEnabled, onlyDirect },
    ],
    queryFn: () =>
      api<{ items: UserRow[] }>(
        `/api/v1/findings/by-user${buildQuery({
          q,
          source: sources.length > 0 ? sources : ['__NONE__'], // forçar empty se nenhum
          hideServiceAccounts,
          hideExceptions,
          onlyEnabled,
          onlyDirect,
          limit: 500,
        })}`,
      ),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          padding: 12,
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <input
          placeholder="Buscar nome, SAM, email, departamento..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{
            flex: 1,
            minWidth: 280,
            padding: '6px 10px',
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            color: 'var(--color-text)',
            fontSize: 13,
          }}
        />

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>Origem:</span>
          {ALL_SOURCES.map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => toggleSource(s)}
              style={{
                padding: '3px 8px',
                fontSize: 11,
                borderRadius: 999,
                border: '1px solid var(--color-border)',
                background: sources.includes(s) ? 'var(--color-surface-2)' : 'transparent',
                color: sources.includes(s) ? 'var(--color-text)' : 'var(--color-muted)',
                fontWeight: sources.includes(s) ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        <Toggle label="Só habilitados" value={onlyEnabled} onChange={setOnlyEnabled} />
        <Toggle
          label="Só adições diretas (sem via grupo)"
          value={onlyDirect}
          onChange={setOnlyDirect}
        />
        <Toggle
          label="Esconder service accounts"
          value={hideServiceAccounts}
          onChange={setHideServiceAccounts}
        />
        <Toggle
          label="Esconder exceções"
          value={hideExceptions}
          onChange={setHideExceptions}
        />
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
                <th style={{ ...thStyle, width: 24 }} />
                <th style={thStyle}>Usuário</th>
                <th style={thStyle}>SAM / UPN</th>
                <th style={thStyle}>Email</th>
                <th style={thStyle}>Departamento</th>
                <th style={thStyle}>AD</th>
                <th style={{ ...thStyle, textAlign: 'right' }} title="Total de máquinas onde é admin">
                  Máquinas
                </th>
                <th
                  style={{ ...thStyle, textAlign: 'right' }}
                  title="Máquinas onde foi adicionado direto ao Administrators local (não via grupo)"
                >
                  Direto
                </th>
                <th
                  style={{ ...thStyle, textAlign: 'right' }}
                  title="Máquinas onde herda admin via grupo AD"
                >
                  Via grupo
                </th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Críticos</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Altos</th>
                <th style={thStyle}>Origem</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((u) => {
                const expanded = expandedSid === u.sid;
                return (
                  <UserAggregateRow
                    key={u.sid}
                    user={u}
                    expanded={expanded}
                    onToggle={() => setExpandedSid(expanded ? null : u.sid)}
                  />
                );
              })}
              {data && data.items.length === 0 && (
                <tr>
                  <td colSpan={12} style={{ ...tdStyle, textAlign: 'center', color: 'var(--color-muted)' }}>
                    Nenhum usuário casa com esses filtros.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {data && (
        <div style={{ color: 'var(--color-muted)', fontSize: 12 }}>
          {data.items.length} usuários distintos · click numa linha para ver as máquinas
        </div>
      )}
    </div>
  );
}

function UserAggregateRow({
  user,
  expanded,
  onToggle,
}: {
  user: UserRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { data: machines, isLoading } = useQuery({
    queryKey: ['findings', 'user-machines', user.sid],
    queryFn: () =>
      api<{ items: MachineRow[] }>(
        `/api/v1/findings/users/${encodeURIComponent(user.sid)}/machines`,
      ),
    enabled: expanded,
  });

  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor: 'pointer',
          background: expanded ? 'var(--color-surface-2)' : undefined,
        }}
      >
        <td style={{ ...tdStyle, color: 'var(--color-muted)' }}>{expanded ? '▾' : '▸'}</td>
        <td style={tdStyle}>
          <div style={{ fontWeight: 600 }}>{user.name}</div>
          {user.title && (
            <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>{user.title}</div>
          )}
        </td>
        <td style={tdStyle}>
          <div>{user.sam_account_name ?? '—'}</div>
          {user.user_principal_name && (
            <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>
              {user.user_principal_name}
            </div>
          )}
        </td>
        <td style={tdStyle}>{user.email ?? '—'}</td>
        <td style={tdStyle}>{user.department ?? '—'}</td>
        <td style={tdStyle}>
          {user.ad_enabled === null ? (
            <span style={{ color: 'var(--color-muted)' }}>—</span>
          ) : user.ad_enabled ? (
            <span style={{ color: '#79d28a', fontSize: 12 }}>habilitado</span>
          ) : (
            <span style={{ color: 'var(--color-critical)', fontWeight: 600, fontSize: 12 }}>
              DESABILITADO
            </span>
          )}
          {user.is_service_account && (
            <div style={{ fontSize: 10, color: 'var(--color-muted)' }}>service account</div>
          )}
          {user.has_exception && (
            <div style={{ fontSize: 10, color: '#7ab2ff' }}>tem exception</div>
          )}
        </td>
        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600, fontSize: 15 }}>
          {user.machine_count}
        </td>
        <td
          style={{
            ...tdStyle,
            textAlign: 'right',
            fontWeight: user.direct_machine_count > 0 ? 600 : 400,
            color:
              user.direct_machine_count > 0 ? 'var(--color-critical)' : 'var(--color-muted)',
          }}
          title={
            user.direct_machine_count > 0
              ? 'Adicionado direto ao Administrators local (requer atenção)'
              : 'Sem adição direta — só via grupo'
          }
        >
          {user.direct_machine_count}
        </td>
        <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--color-muted)' }}>
          {user.via_group_count}
        </td>
        <td
          style={{
            ...tdStyle,
            textAlign: 'right',
            color: user.critical_count > 0 ? 'var(--color-critical)' : 'var(--color-muted)',
            fontWeight: user.critical_count > 0 ? 600 : 400,
          }}
        >
          {user.critical_count}
        </td>
        <td
          style={{
            ...tdStyle,
            textAlign: 'right',
            color: user.high_count > 0 ? 'var(--color-high)' : 'var(--color-muted)',
            fontWeight: user.high_count > 0 ? 600 : 400,
          }}
        >
          {user.high_count}
        </td>
        <td style={tdStyle}>
          <span style={{ fontSize: 11 }}>{user.source}</span>
          {user.via_group_count > 0 && user.direct_machine_count === 0 && (
            <div style={{ fontSize: 10, color: 'var(--color-muted)' }}>só via grupo</div>
          )}
          {user.direct_machine_count > 0 && user.via_group_count > 0 && (
            <div style={{ fontSize: 10, color: 'var(--color-muted)' }}>direto + grupo</div>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={12} style={{ ...tdStyle, padding: 16, background: 'var(--color-surface-2)' }}>
            {isLoading ? (
              <div>Carregando máquinas...</div>
            ) : machines && machines.items.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  Máquinas onde {user.name} é admin local
                </div>
                <table style={{ ...tableStyle, fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Host</th>
                      <th style={thStyle}>Último user logado</th>
                      <th style={thStyle}>Via grupo</th>
                      <th style={thStyle}>Severidade</th>
                      <th style={thStyle}>Último scan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {machines.items.map((m) => (
                      <tr key={m.machine_id}>
                        <td style={tdStyle}>{m.host_name}</td>
                        <td style={tdStyle}>{m.last_logged_user ?? '—'}</td>
                        <td style={tdStyle}>{m.via_group ?? '— (direto)'}</td>
                        <td style={tdStyle}>
                          <SeverityBadge value={m.severity} />
                        </td>
                        <td style={tdStyle}>
                          {new Date(m.last_seen_at).toLocaleString('pt-BR')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ color: 'var(--color-muted)' }}>
                Sem máquinas (estado pode ter mudado desde a coleta).
              </div>
            )}
          </td>
        </tr>
      )}
    </>
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
