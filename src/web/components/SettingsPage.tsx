import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@web/lib/api.ts';
import { useState } from 'react';
import { tableStyle, tdStyle, thStyle } from './Dashboard.tsx';

interface Exception {
  id: string;
  scope: string;
  scopeValue: string | null;
  matchKind: string;
  matchValue: string;
  reason: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
}

export function SettingsPage() {
  const [pwd, setPwd] = useState({ current: '', next: '', confirm: '' });
  const [pwdMsg, setPwdMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [ldapTest, setLdapTest] = useState<{ ok: boolean; msg: string } | null>(null);

  const changePassword = useMutation({
    mutationFn: () =>
      api('/api/v1/auth/change-password', {
        method: 'POST',
        json: { currentPassword: pwd.current, newPassword: pwd.next },
      }),
    onSuccess: () => {
      setPwdMsg({ ok: true, msg: 'Senha atualizada' });
      setPwd({ current: '', next: '', confirm: '' });
    },
    onError: (err) => {
      setPwdMsg({ ok: false, msg: err instanceof ApiError ? err.message : 'Erro' });
    },
  });

  const testLdap = useMutation({
    mutationFn: () => api<{ ok: boolean; message?: string }>('/api/v1/ad/test', { method: 'POST' }),
    onSuccess: (r) => setLdapTest({ ok: r.ok, msg: r.ok ? 'Bind OK' : (r.message ?? 'falha') }),
    onError: (err) =>
      setLdapTest({ ok: false, msg: err instanceof ApiError ? err.message : 'Erro' }),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: 0 }}>Configurações</h1>

      <Panel title="Trocar senha">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 }}>
          <input
            type="password"
            placeholder="Senha atual"
            value={pwd.current}
            onChange={(e) => setPwd({ ...pwd, current: e.target.value })}
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="Nova senha (mín. 12)"
            value={pwd.next}
            onChange={(e) => setPwd({ ...pwd, next: e.target.value })}
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="Confirme a nova senha"
            value={pwd.confirm}
            onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })}
            style={inputStyle}
          />
          {pwdMsg && (
            <div
              style={{
                fontSize: 13,
                color: pwdMsg.ok ? '#79d28a' : 'var(--color-critical)',
              }}
            >
              {pwdMsg.msg}
            </div>
          )}
          <button
            type="button"
            disabled={
              changePassword.isPending ||
              !pwd.current ||
              pwd.next.length < 12 ||
              pwd.next !== pwd.confirm
            }
            onClick={() => changePassword.mutate()}
            style={primaryBtn}
          >
            Atualizar senha
          </button>
        </div>
      </Panel>

      <Panel title="LDAP / Active Directory">
        <div style={{ color: 'var(--color-muted)', fontSize: 13, marginBottom: 8 }}>
          As credenciais ficam no <code>.env</code> do servidor. Este botão testa o bind atual.
        </div>
        <button type="button" onClick={() => testLdap.mutate()} style={primaryBtn}>
          {testLdap.isPending ? 'Testando...' : 'Testar conexão LDAP'}
        </button>
        {ldapTest && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: ldapTest.ok ? '#79d28a' : 'var(--color-critical)',
            }}
          >
            {ldapTest.msg}
          </div>
        )}
      </Panel>

      <ExceptionsPanel />

      <ReprocessPanel />
    </div>
  );
}

interface ReprocessResult {
  adUsersDeleted: number;
  effectiveMembersDeleted: number;
  findingsEventsDeleted: number;
  scansMarkedPending: number;
}

function ReprocessPanel() {
  const qc = useQueryClient();
  const [result, setResult] = useState<ReprocessResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reprocess = useMutation({
    mutationFn: () => api<ReprocessResult>('/api/v1/admin/reprocess-all', { method: 'POST' }),
    onSuccess: (r) => {
      setResult(r);
      setError(null);
      qc.invalidateQueries({ queryKey: ['machine'] });
      qc.invalidateQueries({ queryKey: ['machines'] });
      qc.invalidateQueries({ queryKey: ['findings'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['severity-policies'] });
      qc.invalidateQueries({ queryKey: ['institutional-groups'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro'),
  });

  const handleClick = () => {
    const ok = window.confirm(
      'Tem certeza que deseja reprocessar todos os scans?\n\n' +
        'O que vai acontecer:\n' +
        '• O cache de usuários do AD será limpo (LDAP fresh no próximo run).\n' +
        '• Todos os admins efetivos (effective_members) do último scan de cada máquina serão apagados.\n' +
        '• Os eventos de admin (ADMIN_ADDED, ADMIN_REMOVED, ORPHAN_DETECTED) serão apagados.\n' +
        '• O último scan de cada máquina será marcado como "pending" para o enricher reprocessar.\n\n' +
        'Não toca em: tags, notas, exceções, política de severidade, grupos institucionais ou histórico de scans.\n\n' +
        'O reprocessamento leva alguns minutos dependendo do tamanho do parque.',
    );
    if (ok) reprocess.mutate();
  };

  return (
    <Panel title="Reprocessar scans">
      <div style={{ color: 'var(--color-muted)', fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
        Force o enricher a refazer o último scan de cada máquina usando dados{' '}
        <strong>frescos do AD</strong>. Útil após:
        <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
          <li>
            mudar a configuração LDAP em <code>.env</code>;
          </li>
          <li>
            cadastrar exceções, grupos institucionais ou política de severidade que afetem casos
            antigos cuja recomputação automática não cobriu;
          </li>
          <li>
            limpar erros de expansão (<code>expansion_error</code>) acumulados.
          </li>
        </ul>
        Operação atômica em transação — segura, mas reabre a fila do enricher. Em parques grandes
        pode levar alguns minutos para o estado consolidar.
      </div>

      <button
        type="button"
        onClick={handleClick}
        disabled={reprocess.isPending}
        style={{
          ...primaryBtn,
          background: 'rgba(229, 138, 60, 0.18)',
          color: '#f0a262',
          border: '1px solid rgba(224, 138, 60, 0.4)',
        }}
      >
        {reprocess.isPending ? 'Reprocessando...' : 'Reprocessar todos os scans'}
      </button>

      {error && (
        <div style={{ color: 'var(--color-critical)', fontSize: 13, marginTop: 8 }}>{error}</div>
      )}

      {result && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 13,
            color: 'var(--color-muted)',
            lineHeight: 1.6,
          }}
        >
          <div style={{ color: '#79d28a', fontWeight: 600, marginBottom: 6 }}>
            Reprocessamento iniciado
          </div>
          <div>
            Scans marcados como pending:{' '}
            <strong>{result.scansMarkedPending.toLocaleString('pt-BR')}</strong>
          </div>
          <div>
            Effective members removidos:{' '}
            <strong>{result.effectiveMembersDeleted.toLocaleString('pt-BR')}</strong>
          </div>
          <div>
            Eventos de admin removidos:{' '}
            <strong>{result.findingsEventsDeleted.toLocaleString('pt-BR')}</strong>
          </div>
          <div>
            Cache de AD limpo:{' '}
            <strong>{result.adUsersDeleted.toLocaleString('pt-BR')} registros</strong>
          </div>
          <div style={{ marginTop: 6, fontStyle: 'italic' }}>
            O enricher já está processando — acompanhe em <code>/machines</code> ou no log do
            container.
          </div>
        </div>
      )}
    </Panel>
  );
}

function ExceptionsPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['exceptions'],
    queryFn: () => api<{ items: Exception[] }>('/api/v1/exceptions'),
  });

  const [form, setForm] = useState({
    scope: 'global' as 'global' | 'machine' | 'tag',
    scopeValue: '',
    matchKind: 'group' as 'sid' | 'sam' | 'group',
    matchValue: '',
    reason: '',
  });

  const create = useMutation({
    mutationFn: () =>
      api('/api/v1/exceptions', {
        method: 'POST',
        json: {
          scope: form.scope,
          scopeValue: form.scope === 'global' ? null : form.scopeValue,
          matchKind: form.matchKind,
          matchValue: form.matchValue,
          reason: form.reason,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      setForm({
        scope: 'global',
        scopeValue: '',
        matchKind: 'group',
        matchValue: '',
        reason: '',
      });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/exceptions/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exceptions'] }),
  });

  return (
    <Panel title="Exceções (whitelist)">
      <div style={{ color: 'var(--color-muted)', fontSize: 13, marginBottom: 12 }}>
        Marque combinações esperadas (ex.: grupo <code>MM-Admins-TI</code> em todas as máquinas).
        Achados cobertos por uma exceção viram severidade <strong>info</strong>.
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr) auto',
          gap: 8,
          marginBottom: 16,
        }}
      >
        <select
          value={form.scope}
          onChange={(e) => setForm({ ...form, scope: e.target.value as typeof form.scope })}
          style={inputStyle}
        >
          <option value="global">Global</option>
          <option value="machine">Máquina (id)</option>
          <option value="tag">Tag</option>
        </select>
        <input
          placeholder={form.scope === 'global' ? '—' : 'scopeValue'}
          value={form.scopeValue}
          onChange={(e) => setForm({ ...form, scopeValue: e.target.value })}
          disabled={form.scope === 'global'}
          style={inputStyle}
        />
        <select
          value={form.matchKind}
          onChange={(e) => setForm({ ...form, matchKind: e.target.value as typeof form.matchKind })}
          style={inputStyle}
        >
          <option value="group">Grupo (cn ou SID)</option>
          <option value="sam">SAM (usuário)</option>
          <option value="sid">SID</option>
        </select>
        <input
          placeholder="Valor a casar"
          value={form.matchValue}
          onChange={(e) => setForm({ ...form, matchValue: e.target.value })}
          style={inputStyle}
        />
        <input
          placeholder="Motivo (obrigatório)"
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          style={inputStyle}
        />
        <button
          type="button"
          disabled={!form.matchValue || !form.reason || create.isPending}
          onClick={() => create.mutate()}
          style={primaryBtn}
        >
          Adicionar
        </button>
      </div>

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Escopo</th>
            <th style={thStyle}>Tipo</th>
            <th style={thStyle}>Valor</th>
            <th style={thStyle}>Motivo</th>
            <th style={thStyle}>Criada por</th>
            <th style={thStyle}>Criada em</th>
            <th style={thStyle}>Expira</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.items.map((it) => (
            <tr key={it.id}>
              <td style={tdStyle}>
                {it.scope}
                {it.scopeValue ? ` (${it.scopeValue})` : ''}
              </td>
              <td style={tdStyle}>{it.matchKind}</td>
              <td style={tdStyle}>{it.matchValue}</td>
              <td style={tdStyle}>{it.reason}</td>
              <td style={tdStyle}>{it.createdBy}</td>
              <td style={tdStyle}>{new Date(it.createdAt).toLocaleString('pt-BR')}</td>
              <td style={tdStyle}>
                {it.expiresAt ? new Date(it.expiresAt).toLocaleString('pt-BR') : '—'}
              </td>
              <td style={tdStyle}>
                <button
                  type="button"
                  onClick={() => remove.mutate(it.id)}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-critical)',
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  Remover
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
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

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: 'var(--color-text)',
  fontSize: 13,
};

const primaryBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--color-accent)',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
};
