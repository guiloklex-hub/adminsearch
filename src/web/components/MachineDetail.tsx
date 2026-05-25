import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@web/lib/api.ts';
import { useEffect, useState } from 'react';
import { tableStyle, tdStyle, thStyle } from './Dashboard.tsx';
import { RemediationModal, type RemediationTarget } from './RemediationModal.tsx';
import { SeverityBadge } from './SeverityBadge.tsx';

interface MachineDetail {
  machine: {
    id: string;
    dnsHostName: string;
    netBiosName: string;
    domain: string | null;
    biosSerial: string | null;
    chassisUuid: string | null;
    primaryMac: string | null;
    osCaption: string | null;
    osVersion: string | null;
    osBuild: string | null;
    lastBootAt: string | null;
    lastLoggedUser: string | null;
    ipAddresses: string[] | null;
    agentVersion: string | null;
    tags: string[] | null;
    notes: string | null;
    lastSeenAt: string;
    firstSeenAt: string;
  };
  latestScan: { id: string; collectedAt: string; source: string } | null;
  admins: Array<{
    sid: string;
    name: string | null;
    source: string;
    viaGroup: string | null;
    severity: string;
    severityReason: string;
    adEnabled: boolean | null;
  }>;
  maxSeverity: string | null;
  severityDrivers: Array<{
    sid: string;
    name: string | null;
    viaGroup: string | null;
    reason: string;
  }>;
  events: Array<{
    id: string;
    occurredAt: string;
    kind: string;
    sid: string | null;
    name: string | null;
    details: Record<string, unknown>;
  }>;
  scanHistory: Array<{
    id: string;
    collectedAt: string;
    source: string;
    agentVersion: string | null;
    totalRawMembers: number;
    expansionStatus: string;
  }>;
}

export function MachineDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['machine', id],
    queryFn: () => api<MachineDetail>(`/api/v1/machines/${id}`),
  });

  const [tagsInput, setTagsInput] = useState('');
  const [notes, setNotes] = useState('');
  const [removeTarget, setRemoveTarget] = useState<RemediationTarget | null>(null);
  const [institutionalTarget, setInstitutionalTarget] = useState<{
    sid: string;
    suggestedName: string;
  } | null>(null);

  // Sincroniza inputs locais quando os dados da máquina chegam (ou quando a
  // navegação muda de máquina). Roda só na mudança de id/data — não bate na
  // edição em andamento.
  useEffect(() => {
    if (data?.machine.id === id) {
      setTagsInput((data.machine.tags ?? []).join(', '));
      setNotes(data.machine.notes ?? '');
    }
  }, [data?.machine.id, id, data?.machine.tags, data?.machine.notes]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api(`/api/v1/machines/${id}`, {
        method: 'PATCH',
        json: {
          tags: tagsInput
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          notes,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machine', id] });
      qc.invalidateQueries({ queryKey: ['machines'] });
    },
  });

  if (isLoading) return <div>Carregando...</div>;
  if (!data) return <div>Não encontrado.</div>;

  const m = data.machine;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button
        type="button"
        onClick={onBack}
        style={{
          alignSelf: 'flex-start',
          background: 'transparent',
          border: '1px solid var(--color-border)',
          color: 'var(--color-muted)',
          padding: '4px 10px',
          borderRadius: 6,
          fontSize: 12,
        }}
      >
        ← Voltar
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{m.dnsHostName}</h1>
        {data.maxSeverity && <SeverityBadge value={data.maxSeverity} />}
      </div>
      <div style={{ color: 'var(--color-muted)' }}>
        {m.netBiosName} · {m.domain ?? 'workgroup'} · {m.osCaption}
      </div>

      {data.maxSeverity && data.maxSeverity !== 'info' && data.severityDrivers.length > 0 && (
        <SeverityReasonPanel severity={data.maxSeverity} drivers={data.severityDrivers} />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Panel title="Identidade">
          <Field label="FQDN" value={m.dnsHostName} />
          <Field label="NetBIOS" value={m.netBiosName} />
          <Field label="Domínio" value={m.domain} />
          <Field label="Serial BIOS" value={m.biosSerial} mono />
          <Field label="Chassis UUID" value={m.chassisUuid} mono />
          <Field label="MAC primário" value={m.primaryMac} mono />
          <Field label="IPs" value={(m.ipAddresses ?? []).join(', ')} />
        </Panel>

        <Panel title="Inventário">
          <Field label="SO" value={`${m.osCaption ?? '—'} (${m.osVersion ?? '?'})`} />
          <Field label="Build" value={m.osBuild} />
          <Field
            label="Último boot"
            value={m.lastBootAt ? new Date(m.lastBootAt).toLocaleString('pt-BR') : '—'}
          />
          <Field label="Último usuário" value={m.lastLoggedUser} />
          <Field label="Agent" value={m.agentVersion} />
          <Field
            label="Visto pela 1ª vez"
            value={new Date(m.firstSeenAt).toLocaleString('pt-BR')}
          />
          <Field label="Último contato" value={new Date(m.lastSeenAt).toLocaleString('pt-BR')} />
        </Panel>
      </div>

      <Panel title="Tags & Notas">
        <label style={{ fontSize: 12, color: 'var(--color-muted)' }}>
          Tags (separadas por vírgula)
        </label>
        <input
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          style={inputStyle}
          placeholder="ex.: critical, kiosk, lab"
        />
        <label style={{ fontSize: 12, color: 'var(--color-muted)', marginTop: 12 }}>Notas</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
        />
        <button
          type="button"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          style={{
            alignSelf: 'flex-start',
            marginTop: 12,
            padding: '6px 12px',
            background: 'var(--color-accent)',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          {saveMutation.isPending ? 'Salvando...' : 'Salvar'}
        </button>
      </Panel>

      <Panel title={`Administradores (${data.admins.length})`}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Usuário</th>
              <th style={thStyle}>Origem</th>
              <th style={thStyle}>Via grupo</th>
              <th style={thStyle}>Habilitada AD</th>
              <th style={thStyle}>Severidade</th>
              <th style={thStyle}>SID</th>
              <th style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {data.admins.map((a) => {
              const canRemediate =
                ['critical', 'high', 'medium'].includes(a.severity) && a.source !== 'WELL_KNOWN';
              return (
                <tr key={`${a.sid}-${a.viaGroup ?? 'direct'}`}>
                  <td style={tdStyle}>{a.name ?? '—'}</td>
                  <td style={tdStyle}>{a.source}</td>
                  <td style={tdStyle}>{a.viaGroup ?? '— (direto)'}</td>
                  <td style={tdStyle}>
                    {a.adEnabled === null ? '—' : a.adEnabled ? 'sim' : 'NÃO'}
                  </td>
                  <td style={tdStyle}>
                    <SeverityBadge value={a.severity} description={a.severityReason} />
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 11 }}>{a.sid}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      {a.viaGroup === null && a.source !== 'WELL_KNOWN' && (
                        <button
                          type="button"
                          onClick={() =>
                            setInstitutionalTarget({
                              sid: a.sid,
                              suggestedName:
                                a.name && a.name !== '{}'
                                  ? a.name.includes('\\')
                                    ? (a.name.split('\\').pop() ?? a.name)
                                    : a.name
                                  : '',
                            })
                          }
                          style={{
                            padding: '2px 8px',
                            background: 'transparent',
                            border: '1px solid var(--color-border)',
                            color: 'var(--color-muted)',
                            borderRadius: 4,
                            fontSize: 11,
                          }}
                          title="Cadastrar este SID como grupo institucional da empresa"
                        >
                          Grupo institucional
                        </button>
                      )}
                      {canRemediate && (
                        <button
                          type="button"
                          onClick={() =>
                            setRemoveTarget({
                              machineId: id,
                              hostName: m.dnsHostName,
                              sid: a.sid,
                              name: a.name,
                              severity: a.severity,
                              source: a.source,
                              viaGroup: a.viaGroup,
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
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <Panel title="Eventos recentes">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Quando</th>
              <th style={thStyle}>Evento</th>
              <th style={thStyle}>Usuário/Item</th>
              <th style={thStyle}>Detalhes</th>
            </tr>
          </thead>
          <tbody>
            {data.events.map((e) => (
              <tr key={e.id}>
                <td style={tdStyle}>{new Date(e.occurredAt).toLocaleString('pt-BR')}</td>
                <td style={tdStyle}>
                  <code style={{ fontSize: 11 }}>{e.kind}</code>
                </td>
                <td style={tdStyle}>{e.name ?? e.sid ?? '—'}</td>
                <td style={{ ...tdStyle, fontSize: 12, color: 'var(--color-muted)' }}>
                  {JSON.stringify(e.details)}
                </td>
              </tr>
            ))}
            {data.events.length === 0 && (
              <tr>
                <td colSpan={4} style={{ ...tdStyle, color: 'var(--color-muted)' }}>
                  Sem eventos.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <Panel title="Histórico de scans">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Quando</th>
              <th style={thStyle}>Origem</th>
              <th style={thStyle}>Agent</th>
              <th style={thStyle}>Membros</th>
              <th style={thStyle}>Expansão</th>
            </tr>
          </thead>
          <tbody>
            {data.scanHistory.map((s) => (
              <tr key={s.id}>
                <td style={tdStyle}>{new Date(s.collectedAt).toLocaleString('pt-BR')}</td>
                <td style={tdStyle}>{s.source}</td>
                <td style={tdStyle}>{s.agentVersion ?? '—'}</td>
                <td style={tdStyle}>{s.totalRawMembers}</td>
                <td style={tdStyle}>{s.expansionStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <RemediationModal
        target={removeTarget}
        onClose={() => setRemoveTarget(null)}
        onPlanned={() => setRemoveTarget(null)}
      />

      <InstitutionalGroupModal
        target={institutionalTarget}
        onClose={() => setInstitutionalTarget(null)}
        onSaved={() => {
          setInstitutionalTarget(null);
          qc.invalidateQueries({ queryKey: ['machine', id] });
          qc.invalidateQueries({ queryKey: ['institutional-groups'] });
          qc.invalidateQueries({ queryKey: ['severity-policies'] });
        }}
      />
    </div>
  );
}

function InstitutionalGroupModal({
  target,
  onClose,
  onSaved,
}: {
  target: { sid: string; suggestedName: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [samAccountName, setSamAccountName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setDisplayName(target.suggestedName);
      setSamAccountName('');
      setError(null);
    }
  }, [target]);

  const mutation = useMutation({
    mutationFn: () =>
      api(`/api/v1/institutional-groups/${encodeURIComponent(target?.sid ?? '')}`, {
        method: 'PUT',
        json: { displayName, samAccountName: samAccountName.trim() || null },
      }),
    onSuccess: () => onSaved(),
    onError: (err) => setError((err as Error).message),
  });

  if (!target) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="document"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          padding: 24,
          width: 520,
          maxWidth: '90vw',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 16 }}>Cadastrar grupo institucional</div>
        <div style={{ fontSize: 13, color: 'var(--color-muted)', lineHeight: 1.5 }}>
          Esse SID passa a ser tratado como grupo institucional conhecido — vira{' '}
          <strong>Baixo</strong> em todas as máquinas e o nome cadastrado substitui o atual
          imediatamente.
        </div>

        <label style={{ fontSize: 12, color: 'var(--color-muted)' }}>SID</label>
        <input
          value={target.sid}
          readOnly
          style={{ ...inputStyle, fontFamily: 'monospace', opacity: 0.7 }}
        />

        <label style={{ fontSize: 12, color: 'var(--color-muted)' }}>Nome amigável</label>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="ex.: MM - Workstation Admins"
          style={inputStyle}
        />

        <label style={{ fontSize: 12, color: 'var(--color-muted)' }}>
          sAMAccountName (opcional, ajuda o LDAP a achar)
        </label>
        <input
          value={samAccountName}
          onChange={(e) => setSamAccountName(e.target.value)}
          placeholder="ex.: MM-Workstation-Admins"
          style={inputStyle}
        />

        {error && <div style={{ color: 'var(--color-critical)', fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: '1px solid var(--color-border)',
              color: 'var(--color-muted)',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => {
              const name = displayName.trim();
              if (!name) {
                setError('Nome amigável é obrigatório.');
                return;
              }
              setError(null);
              mutation.mutate();
            }}
            disabled={mutation.isPending}
            style={{
              padding: '6px 14px',
              background: 'var(--color-accent)',
              border: 'none',
              color: 'white',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {mutation.isPending ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
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
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
      <span style={{ color: 'var(--color-muted)', fontSize: 12 }}>{label}</span>
      <span
        style={{
          fontFamily: mono ? 'monospace' : undefined,
          fontSize: mono ? 12 : 13,
        }}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: 'var(--color-text)',
  fontSize: 14,
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Crítica',
  high: 'Alta',
  medium: 'Média',
  low: 'Baixa',
  info: 'Info',
};

const SEVERITY_ACCENT: Record<string, { bg: string; border: string }> = {
  critical: { bg: 'rgba(229, 69, 69, 0.10)', border: 'rgba(229, 69, 69, 0.45)' },
  high: { bg: 'rgba(224, 138, 60, 0.10)', border: 'rgba(224, 138, 60, 0.45)' },
  medium: { bg: 'rgba(212, 181, 65, 0.10)', border: 'rgba(212, 181, 65, 0.45)' },
  low: { bg: 'rgba(91, 155, 229, 0.10)', border: 'rgba(91, 155, 229, 0.45)' },
};

function SeverityReasonPanel({
  severity,
  drivers,
}: {
  severity: string;
  drivers: Array<{ sid: string; name: string | null; viaGroup: string | null; reason: string }>;
}) {
  const accent = SEVERITY_ACCENT[severity] ?? SEVERITY_ACCENT.medium;
  const label = SEVERITY_LABEL[severity] ?? severity;
  return (
    <div
      style={{
        background: accent.bg,
        border: `1px solid ${accent.border}`,
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600 }}>Por que esta máquina é {label}?</div>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {drivers.map((d) => (
          <li key={`${d.sid}-${d.viaGroup ?? 'direct'}`} style={{ fontSize: 13, lineHeight: 1.5 }}>
            <strong>{d.name ?? d.sid}</strong>
            {d.viaGroup ? ` (via ${d.viaGroup})` : ' (direto)'} — {d.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
