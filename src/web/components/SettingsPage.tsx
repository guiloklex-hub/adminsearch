import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '@web/lib/api.ts';
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
    onSuccess: (r) => setLdapTest({ ok: r.ok, msg: r.ok ? 'Bind OK' : r.message ?? 'falha' }),
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
    </div>
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr) auto', gap: 8, marginBottom: 16 }}>
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
              <td style={tdStyle}>{it.expiresAt ? new Date(it.expiresAt).toLocaleString('pt-BR') : '—'}</td>
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
