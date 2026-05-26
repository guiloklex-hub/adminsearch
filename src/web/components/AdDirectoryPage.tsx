import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, buildQuery } from '@web/lib/api.ts';
import { useEffect, useState } from 'react';
import { AdDirectoryGroupDetail } from './AdDirectoryGroupDetail.tsx';
import { AdDirectoryUserDetail } from './AdDirectoryUserDetail.tsx';
import { tableStyle, tdStyle, thStyle } from './Dashboard.tsx';
import { Pagination } from './Pagination.tsx';

type Tab = 'groups' | 'users';
type Scope = 'global' | 'domain_local' | 'universal' | 'builtin';
const SCOPE_OPTIONS: Scope[] = ['global', 'domain_local', 'universal', 'builtin'];

interface AdGroupRow {
  sid: string;
  name: string;
  sam_account_name: string | null;
  cn: string | null;
  description: string | null;
  scope: Scope | null;
  is_security: boolean | null;
  member_count: number;
  last_synced_at: string | null;
}

interface AdUserRow {
  sid: string;
  sam_account_name: string | null;
  user_principal_name: string | null;
  display_name: string | null;
  email: string | null;
  department: string | null;
  title: string | null;
  enabled: boolean | null;
  is_service_account: boolean;
  last_logon: string | null;
  group_count: number;
}

interface SyncStatus {
  enabled: boolean;
  currentRun: {
    id: string;
    startedAt: string;
    triggeredBy: string;
  } | null;
  lastSync: {
    id: string;
    startedAt: string;
    finishedAt: string | null;
    status: 'success' | 'failed';
    usersTotal: number | null;
    groupsTotal: number | null;
    membershipsTotal: number | null;
    durationMs: number | null;
    errorMessage: string | null;
    triggeredBy: string;
  } | null;
}

export function AdDirectoryPage() {
  const [tab, setTab] = useState<Tab>('groups');

  // Filtros da aba "Grupos"
  const [groupQ, setGroupQ] = useState('');
  const [groupScope, setGroupScope] = useState<Scope[]>([]);
  const [groupOnlySecurity, setGroupOnlySecurity] = useState(false);

  // Filtros da aba "Usuários" — usados também pelo botão de exportação
  const [userQ, setUserQ] = useState('');
  const [userOnlyEnabled, setUserOnlyEnabled] = useState(true);
  const [userHideServiceAccounts, setUserHideServiceAccounts] = useState(false);

  // Drawers
  const [selectedGroupSid, setSelectedGroupSid] = useState<string | null>(null);
  const [selectedUserSid, setSelectedUserSid] = useState<string | null>(null);

  const exportHref = `/api/v1/export/ad-directory.csv${buildQuery({
    q: userQ,
    onlyEnabled: userOnlyEnabled,
    hideServiceAccounts: userHideServiceAccounts,
  })}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <h1 style={{ margin: 0 }}>AD — Grupos e Usuários</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <SyncStatusPill />
          <SyncTriggerButton />
          <a
            href={exportHref}
            style={{
              background: 'var(--color-accent)',
              color: 'white',
              padding: '6px 12px',
              borderRadius: 6,
              fontSize: 13,
              textDecoration: 'none',
            }}
            title="1 linha por par usuário×grupo (usuário com N grupos vira N linhas)"
          >
            Exportar CSV
          </a>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        {(['groups', 'users'] as const).map((t) => (
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
              cursor: 'pointer',
            }}
          >
            {t === 'groups' ? 'Grupos' : 'Usuários'}
          </button>
        ))}
      </div>

      {tab === 'groups' && (
        <GroupsTab
          q={groupQ}
          setQ={setGroupQ}
          scopes={groupScope}
          setScopes={setGroupScope}
          onlySecurity={groupOnlySecurity}
          setOnlySecurity={setGroupOnlySecurity}
          onSelect={setSelectedGroupSid}
        />
      )}
      {tab === 'users' && (
        <UsersTab
          q={userQ}
          setQ={setUserQ}
          onlyEnabled={userOnlyEnabled}
          setOnlyEnabled={setUserOnlyEnabled}
          hideServiceAccounts={userHideServiceAccounts}
          setHideServiceAccounts={setUserHideServiceAccounts}
          onSelect={setSelectedUserSid}
        />
      )}

      {selectedGroupSid && (
        <AdDirectoryGroupDetail sid={selectedGroupSid} onClose={() => setSelectedGroupSid(null)} />
      )}
      {selectedUserSid && (
        <AdDirectoryUserDetail sid={selectedUserSid} onClose={() => setSelectedUserSid(null)} />
      )}
    </div>
  );
}

function GroupsTab(props: {
  q: string;
  setQ: (s: string) => void;
  scopes: Scope[];
  setScopes: (s: Scope[]) => void;
  onlySecurity: boolean;
  setOnlySecurity: (v: boolean) => void;
  onSelect: (sid: string) => void;
}) {
  const { q, setQ, scopes, setScopes, onlySecurity, setOnlySecurity, onSelect } = props;
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    setPage(1);
  }, [q, scopes, onlySecurity, pageSize]);

  const { data, isLoading } = useQuery({
    queryKey: ['ad-directory', 'groups', { q, scopes, onlySecurity, page, pageSize }],
    queryFn: () =>
      api<{ items: AdGroupRow[]; total: number }>(
        `/api/v1/ad-directory/groups${buildQuery({
          q,
          scope: scopes,
          isSecurity: onlySecurity,
          page,
          pageSize,
        })}`,
      ),
  });

  const toggleScope = (s: Scope) => {
    setScopes(scopes.includes(s) ? scopes.filter((x) => x !== s) : [...scopes, s]);
  };

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
          placeholder="Buscar nome, SAM, CN, SID..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ ...searchInputStyle, flex: 1, minWidth: 280 }}
        />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>Escopo:</span>
          {SCOPE_OPTIONS.map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => toggleScope(s)}
              style={pillStyle(scopes.includes(s))}
            >
              {s}
            </button>
          ))}
        </div>
        <label style={toggleLabelStyle}>
          <input
            type="checkbox"
            checked={onlySecurity}
            onChange={(e) => setOnlySecurity(e.target.checked)}
          />
          Só security groups
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
                <th style={thStyle}>Grupo</th>
                <th style={thStyle}>SAM</th>
                <th style={thStyle}>Escopo</th>
                <th style={thStyle}>Tipo</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Membros</th>
                <th style={thStyle}>SID</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((g) => (
                <tr
                  key={g.sid}
                  onClick={() => onSelect(g.sid)}
                  style={{ cursor: 'pointer' }}
                  title="Ver membros deste grupo"
                >
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>{g.name}</div>
                    {g.description && (
                      <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>
                        {g.description}
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>{g.sam_account_name ?? '—'}</td>
                  <td style={tdStyle}>{g.scope ?? '—'}</td>
                  <td style={tdStyle}>
                    {g.is_security === null ? '—' : g.is_security ? 'segurança' : 'distribuição'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                    {g.member_count.toLocaleString('pt-BR')}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 11 }}>{g.sid}</td>
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    style={{ ...tdStyle, textAlign: 'center', color: 'var(--color-muted)' }}
                  >
                    Nenhum grupo encontrado.
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
      <div style={{ color: 'var(--color-muted)', fontSize: 11 }}>
        Clique em um grupo para ver seus membros (transitivos).
      </div>
    </div>
  );
}

function UsersTab(props: {
  q: string;
  setQ: (s: string) => void;
  onlyEnabled: boolean;
  setOnlyEnabled: (v: boolean) => void;
  hideServiceAccounts: boolean;
  setHideServiceAccounts: (v: boolean) => void;
  onSelect: (sid: string) => void;
}) {
  const {
    q,
    setQ,
    onlyEnabled,
    setOnlyEnabled,
    hideServiceAccounts,
    setHideServiceAccounts,
    onSelect,
  } = props;
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    setPage(1);
  }, [q, onlyEnabled, hideServiceAccounts, pageSize]);

  const { data, isLoading } = useQuery({
    queryKey: ['ad-directory', 'users', { q, onlyEnabled, hideServiceAccounts, page, pageSize }],
    queryFn: () =>
      api<{ items: AdUserRow[]; total: number }>(
        `/api/v1/ad-directory/users${buildQuery({
          q,
          onlyEnabled,
          hideServiceAccounts,
          page,
          pageSize,
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
          placeholder="Buscar nome, SAM, UPN, email, departamento, SID..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ ...searchInputStyle, flex: 1, minWidth: 320 }}
        />
        <label style={toggleLabelStyle}>
          <input
            type="checkbox"
            checked={onlyEnabled}
            onChange={(e) => setOnlyEnabled(e.target.checked)}
          />
          Só habilitados
        </label>
        <label style={toggleLabelStyle}>
          <input
            type="checkbox"
            checked={hideServiceAccounts}
            onChange={(e) => setHideServiceAccounts(e.target.checked)}
          />
          Esconder service accounts
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
                <th style={thStyle}>Usuário</th>
                <th style={thStyle}>SAM / UPN</th>
                <th style={thStyle}>Email</th>
                <th style={thStyle}>Departamento</th>
                <th style={thStyle}>AD</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Grupos</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((u) => (
                <tr
                  key={u.sid}
                  onClick={() => onSelect(u.sid)}
                  style={{ cursor: 'pointer' }}
                  title="Ver grupos deste usuário"
                >
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>
                      {u.display_name ?? u.sam_account_name ?? u.sid}
                    </div>
                    {u.title && (
                      <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>{u.title}</div>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <div>{u.sam_account_name ?? '—'}</div>
                    {u.user_principal_name && (
                      <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>
                        {u.user_principal_name}
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>{u.email ?? '—'}</td>
                  <td style={tdStyle}>{u.department ?? '—'}</td>
                  <td style={tdStyle}>
                    {u.enabled === null ? (
                      '—'
                    ) : u.enabled ? (
                      <span style={{ color: '#79d28a', fontSize: 12 }}>habilitado</span>
                    ) : (
                      <span
                        style={{ color: 'var(--color-critical)', fontSize: 12, fontWeight: 600 }}
                      >
                        DESABILITADO
                      </span>
                    )}
                    {u.is_service_account && (
                      <div style={{ fontSize: 10, color: 'var(--color-muted)' }}>
                        service account
                      </div>
                    )}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                    {u.group_count.toLocaleString('pt-BR')}
                  </td>
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    style={{ ...tdStyle, textAlign: 'center', color: 'var(--color-muted)' }}
                  >
                    Nenhum usuário encontrado.
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
      <div style={{ color: 'var(--color-muted)', fontSize: 11 }}>
        Clique em um usuário para ver os grupos a que pertence (transitivamente).
      </div>
    </div>
  );
}

function SyncStatusPill() {
  const { data } = useQuery<SyncStatus>({
    queryKey: ['ad-directory', 'sync-status'],
    queryFn: () => api<SyncStatus>('/api/v1/ad-directory/sync/status'),
    refetchInterval: 5000,
  });

  if (!data?.enabled) {
    return <Pill color="muted">LDAP não configurado</Pill>;
  }
  if (data.currentRun) {
    return (
      <Pill color="amber" title={`iniciado por ${data.currentRun.triggeredBy}`}>
        Sincronizando... (desde {timeAgo(data.currentRun.startedAt)})
      </Pill>
    );
  }
  if (data.lastSync?.status === 'failed') {
    return (
      <Pill color="red" title={data.lastSync.errorMessage ?? ''}>
        Última sync falhou
      </Pill>
    );
  }
  if (data.lastSync?.finishedAt) {
    const summary =
      data.lastSync.usersTotal !== null && data.lastSync.groupsTotal !== null
        ? ` (${data.lastSync.usersTotal.toLocaleString('pt-BR')} users, ${data.lastSync.groupsTotal.toLocaleString('pt-BR')} grupos)`
        : '';
    return (
      <Pill>
        Última sync: {timeAgo(data.lastSync.finishedAt)}
        {summary}
      </Pill>
    );
  }
  return <Pill color="muted">Nunca sincronizado</Pill>;
}

function SyncTriggerButton() {
  const qc = useQueryClient();
  const { data } = useQuery<SyncStatus>({
    queryKey: ['ad-directory', 'sync-status'],
    queryFn: () => api<SyncStatus>('/api/v1/ad-directory/sync/status'),
    refetchInterval: 5000,
  });

  const mut = useMutation({
    mutationFn: () => api('/api/v1/ad-directory/sync', { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ad-directory', 'sync-status'] }),
  });

  const disabled = !data?.enabled || Boolean(data?.currentRun) || mut.isPending;

  return (
    <button
      type="button"
      onClick={() => mut.mutate()}
      disabled={disabled}
      style={{
        padding: '6px 12px',
        background: 'transparent',
        border: '1px solid var(--color-border)',
        color: disabled ? 'var(--color-muted)' : 'var(--color-text)',
        borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 13,
      }}
    >
      {mut.isPending ? 'Disparando...' : 'Sincronizar agora'}
    </button>
  );
}

function Pill({
  children,
  color = 'default',
  title,
}: {
  children: React.ReactNode;
  color?: 'default' | 'amber' | 'red' | 'muted';
  title?: string;
}) {
  const bg =
    color === 'amber'
      ? 'rgba(224, 138, 60, 0.15)'
      : color === 'red'
        ? 'rgba(229, 69, 69, 0.15)'
        : 'var(--color-surface-2)';
  const fg =
    color === 'amber'
      ? '#e08a3c'
      : color === 'red'
        ? 'var(--color-critical)'
        : color === 'muted'
          ? 'var(--color-muted)'
          : 'var(--color-text)';
  return (
    <span
      title={title}
      style={{
        background: bg,
        color: fg,
        border: '1px solid var(--color-border)',
        padding: '4px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      {children}
    </span>
  );
}

const searchInputStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: 'var(--color-text)',
  fontSize: 13,
};

const toggleLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 13,
  color: 'var(--color-text)',
};

function pillStyle(active: boolean): React.CSSProperties {
  return {
    padding: '3px 8px',
    fontSize: 11,
    borderRadius: 999,
    border: '1px solid var(--color-border)',
    background: active ? 'var(--color-surface-2)' : 'transparent',
    color: active ? 'var(--color-text)' : 'var(--color-muted)',
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
  };
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'agora';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
