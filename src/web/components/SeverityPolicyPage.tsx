import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@web/lib/api.ts';
import { tableStyle, tdStyle, thStyle } from './Dashboard.tsx';
import { SeverityBadge } from './SeverityBadge.tsx';

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

interface PolicyItem {
  reasonCode: string;
  title: string;
  description: string;
  defaultSeverity: Severity;
  effectiveSeverity: Severity;
  overridden: boolean;
  override: { severity: Severity; updatedAt: string; updatedBy: string } | null;
  affectedCount: number;
}

const SEVERITY_OPTIONS: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Crítico',
  high: 'Alto',
  medium: 'Médio',
  low: 'Baixo',
  info: 'Info',
};

export function SeverityPolicyPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['severity-policies'],
    queryFn: () => api<{ items: PolicyItem[] }>('/api/v1/severity-policies'),
  });

  const setMutation = useMutation({
    mutationFn: ({ reasonCode, severity }: { reasonCode: string; severity: Severity }) =>
      api(`/api/v1/severity-policies/${reasonCode}`, {
        method: 'PUT',
        json: { severity },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['severity-policies'] }),
  });

  const unsetMutation = useMutation({
    mutationFn: (reasonCode: string) =>
      api(`/api/v1/severity-policies/${reasonCode}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['severity-policies'] }),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: 0 }}>Política de Severidade</h1>

      <div style={infoBox}>
        Cada linha abaixo é um <strong>motivo</strong> pelo qual o sistema classifica um admin
        local. A coluna <em>Padrão</em> mostra o nível que o sistema atribuiria automaticamente; a
        coluna <em>Ajustada</em> mostra o nível que <strong>esta empresa</strong> usa. Mudanças
        aplicam <strong>imediatamente</strong> a todos os achados existentes — você não precisa
        esperar o próximo scan.
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
                <th style={thStyle}>Motivo</th>
                <th style={thStyle}>Padrão</th>
                <th style={thStyle}>Ajustada</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Admins afetados</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {data?.items.map((p) => {
                const busy =
                  (setMutation.isPending && setMutation.variables?.reasonCode === p.reasonCode) ||
                  (unsetMutation.isPending && unsetMutation.variables === p.reasonCode);
                return (
                  <tr key={p.reasonCode}>
                    <td style={{ ...tdStyle, maxWidth: 520 }}>
                      <div style={{ fontWeight: 600 }}>{p.title}</div>
                      <div
                        style={{ color: 'var(--color-muted)', fontSize: 12, marginTop: 2 }}
                        title={p.reasonCode}
                      >
                        {p.description}
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <SeverityBadge value={p.defaultSeverity} />
                    </td>
                    <td style={tdStyle}>
                      <select
                        value={p.effectiveSeverity}
                        disabled={busy}
                        onChange={(e) => {
                          const newSev = e.target.value as Severity;
                          if (newSev === p.effectiveSeverity) return;
                          if (newSev === p.defaultSeverity && p.overridden) {
                            unsetMutation.mutate(p.reasonCode);
                          } else {
                            setMutation.mutate({ reasonCode: p.reasonCode, severity: newSev });
                          }
                        }}
                        style={selectStyle}
                      >
                        {SEVERITY_OPTIONS.map((s) => (
                          <option key={s} value={s}>
                            {SEVERITY_LABEL[s]}
                            {s === p.defaultSeverity ? ' (padrão)' : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                      {p.affectedCount.toLocaleString('pt-BR')}
                    </td>
                    <td style={tdStyle}>
                      {p.overridden && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => unsetMutation.mutate(p.reasonCode)}
                          style={resetBtn}
                          title={`Ajustado por ${p.override?.updatedBy ?? '?'} em ${
                            p.override?.updatedAt
                              ? new Date(p.override.updatedAt).toLocaleString('pt-BR')
                              : '—'
                          }`}
                        >
                          Voltar ao padrão
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {setMutation.isError && (
        <div style={{ color: 'var(--color-critical)' }}>
          Erro ao salvar: {(setMutation.error as Error).message}
        </div>
      )}
      {unsetMutation.isError && (
        <div style={{ color: 'var(--color-critical)' }}>
          Erro ao restaurar: {(unsetMutation.error as Error).message}
        </div>
      )}
    </div>
  );
}

const infoBox: React.CSSProperties = {
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  padding: 12,
  fontSize: 13,
  color: 'var(--color-muted)',
  lineHeight: 1.5,
};

const selectStyle: React.CSSProperties = {
  padding: '4px 8px',
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: 'var(--color-text)',
  fontSize: 13,
  minWidth: 140,
};

const resetBtn: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: 'var(--color-muted)',
  fontSize: 12,
  cursor: 'pointer',
};
