import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@web/lib/api.ts';
import { useState } from 'react';
import { tableStyle, tdStyle, thStyle } from './Dashboard.tsx';

interface InstitutionalGroup {
  sid: string;
  displayName: string;
  samAccountName: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  affectedCount: number;
}

const SID_REGEX = /^S-\d+-\d+(-\d+)*$/i;

export function InstitutionalGroupsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['institutional-groups'],
    queryFn: () => api<{ items: InstitutionalGroup[] }>('/api/v1/institutional-groups'),
  });

  const [form, setForm] = useState({ sid: '', displayName: '', samAccountName: '' });
  const [formError, setFormError] = useState<string | null>(null);

  const upsertMutation = useMutation({
    mutationFn: (input: { sid: string; displayName: string; samAccountName: string | null }) =>
      api(`/api/v1/institutional-groups/${encodeURIComponent(input.sid)}`, {
        method: 'PUT',
        json: { displayName: input.displayName, samAccountName: input.samAccountName },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['institutional-groups'] });
      qc.invalidateQueries({ queryKey: ['machine'] });
      qc.invalidateQueries({ queryKey: ['severity-policies'] });
      setForm({ sid: '', displayName: '', samAccountName: '' });
      setFormError(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (sid: string) =>
      api(`/api/v1/institutional-groups/${encodeURIComponent(sid)}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['institutional-groups'] });
      qc.invalidateQueries({ queryKey: ['machine'] });
      qc.invalidateQueries({ queryKey: ['severity-policies'] });
    },
  });

  const handleSubmit = () => {
    const sid = form.sid.trim();
    const displayName = form.displayName.trim();
    if (!SID_REGEX.test(sid)) {
      setFormError('SID inválido. Esperado formato S-1-5-...');
      return;
    }
    if (!displayName) {
      setFormError('Nome amigável é obrigatório.');
      return;
    }
    upsertMutation.mutate({
      sid,
      displayName,
      samAccountName: form.samAccountName.trim() || null,
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: 0 }}>Grupos Institucionais</h1>

      <div style={infoBox}>
        Cadastre aqui os <strong>SIDs de grupos do AD</strong> da empresa (ex.:
        <code> MM - Workstation Admins</code>) que o sistema não consegue resolver automaticamente —
        eles aparecem como <code>{'{}'}</code> ou nome cinza na tabela de admins. Ao salvar:
        <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
          <li>
            O nome amigável substitui imediatamente todos os <code>{'{}'}</code> existentes.
          </li>
          <li>
            A severidade vai para <strong>Baixo</strong> (ajustável em /severity-policy).
          </li>
          <li>
            No próximo scan, o enricher usa o <em>sAMAccountName</em> cadastrado como hint pro LDAP
            e os membros passam a aparecer como herança via aquele grupo.
          </li>
        </ul>
      </div>

      <div style={panel}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Cadastrar grupo</div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1.5fr auto', gap: 8 }}>
          <input
            placeholder="SID (ex.: S-1-5-21-...-3204)"
            value={form.sid}
            onChange={(e) => setForm({ ...form, sid: e.target.value })}
            style={inputStyle}
          />
          <input
            placeholder="Nome amigável (ex.: MM - Workstation Admins)"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            style={inputStyle}
          />
          <input
            placeholder="sAMAccountName (opcional)"
            value={form.samAccountName}
            onChange={(e) => setForm({ ...form, samAccountName: e.target.value })}
            style={inputStyle}
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={upsertMutation.isPending}
            style={primaryBtn}
          >
            {upsertMutation.isPending ? 'Salvando...' : 'Cadastrar'}
          </button>
        </div>
        {formError && (
          <div style={{ color: 'var(--color-critical)', marginTop: 8, fontSize: 13 }}>
            {formError}
          </div>
        )}
        {upsertMutation.isError && (
          <div style={{ color: 'var(--color-critical)', marginTop: 8, fontSize: 13 }}>
            Erro ao salvar: {(upsertMutation.error as Error).message}
          </div>
        )}
      </div>

      <div style={panel}>
        {isLoading ? (
          <div style={{ padding: 16 }}>Carregando...</div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>SID</th>
                <th style={thStyle}>Nome amigável</th>
                <th style={thStyle}>sAMAccountName</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Admins afetados</th>
                <th style={thStyle}>Cadastrado por</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {data?.items.map((g) => (
                <tr key={g.sid}>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 11 }}>{g.sid}</td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{g.displayName}</td>
                  <td style={tdStyle}>{g.samAccountName ?? '—'}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                    {g.affectedCount.toLocaleString('pt-BR')}
                  </td>
                  <td style={{ ...tdStyle, fontSize: 12, color: 'var(--color-muted)' }}>
                    {g.createdBy}
                  </td>
                  <td style={tdStyle}>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remover o cadastro do grupo "${g.displayName}"? As ${g.affectedCount} linha(s) afetadas voltam à classificação automática.`,
                          )
                        ) {
                          deleteMutation.mutate(g.sid);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                      style={dangerBtn}
                    >
                      Remover
                    </button>
                  </td>
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    style={{ ...tdStyle, textAlign: 'center', color: 'var(--color-muted)' }}
                  >
                    Nenhum grupo institucional cadastrado.
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

const panel: React.CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 12,
  padding: 16,
};

const infoBox: React.CSSProperties = {
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  padding: 12,
  fontSize: 13,
  color: 'var(--color-muted)',
  lineHeight: 1.5,
};

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
  border: 'none',
  borderRadius: 6,
  color: 'white',
  fontSize: 13,
  cursor: 'pointer',
};

const dangerBtn: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: 'var(--color-critical)',
  fontSize: 12,
  cursor: 'pointer',
};
