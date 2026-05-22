import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '@web/lib/api.ts';

interface RemediationTarget {
  machineId: string;
  hostName: string;
  sid: string;
  name: string | null;
  severity: string;
  source: string;
  viaGroup: string | null;
}

export function RemediationModal({
  target,
  onClose,
  onPlanned,
}: {
  target: RemediationTarget | null;
  onClose: () => void;
  onPlanned: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api('/api/v1/remediation/plan', {
        method: 'POST',
        json: {
          machineId: target?.machineId,
          targetSid: target?.sid,
          reason: reason.trim() || undefined,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['remediation'] });
      qc.invalidateQueries({ queryKey: ['findings'] });
      onPlanned();
      onClose();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Erro inesperado');
    },
  });

  if (!target) return null;

  const viaGroupWarning = target.viaGroup
    ? `O usuário é admin via grupo "${target.viaGroup}". O agente NÃO consegue remover só este usuário de um grupo AD na estação — a remoção precisa ser feita no AD (remover o usuário do grupo) ou removendo o grupo inteiro do Administrators local. Por ora, este planejamento ficará marcado para revisão e o agente vai recusar caso o SID alvo seja do próprio grupo.`
    : null;

  return (
    <div style={overlay} onClick={onClose} role="presentation">
      <div
        style={modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <h2 style={{ marginTop: 0 }}>Planejar remoção</h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          <Field label="Máquina" value={target.hostName} />
          <Field label="Usuário" value={target.name ?? target.sid} mono={!target.name} />
          <Field label="Origem" value={`${target.source}${target.viaGroup ? ` (via ${target.viaGroup})` : ''}`} />
          <Field label="Severidade atual" value={target.severity} />
          <Field label="SID" value={target.sid} mono />
        </div>

        {viaGroupWarning && (
          <div style={warningBox}>
            <strong>Atenção — herança por grupo</strong>
            <div style={{ marginTop: 6, fontSize: 13 }}>{viaGroupWarning}</div>
          </div>
        )}

        <div style={infoBox}>
          A remoção é em <strong>duas etapas</strong>: este passo cria um registro
          <em> planejado</em>; depois você precisa <strong>Confirmar</strong> na
          aba "A executar" para o agente realmente remover na próxima coleta.
        </div>

        <label style={{ fontSize: 12, color: 'var(--color-muted)' }}>
          Motivo (opcional — fica em audit log)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="ex.: ex-funcionário, conta indevida, etc."
          style={textareaStyle}
        />

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
          />
          Entendi que esta ação será executada no próximo phone-home do agente após eu confirmar
        </label>

        {error && (
          <div style={{ color: 'var(--color-critical)', marginTop: 8, fontSize: 13 }}>{error}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onClose} style={secondaryBtn}>
            Cancelar
          </button>
          <button
            type="button"
            disabled={!confirm || mutation.isPending}
            onClick={() => mutation.mutate()}
            style={primaryBtn}
          >
            {mutation.isPending ? 'Planejando...' : 'Planejar remoção'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
      <span style={{ color: 'var(--color-muted)' }}>{label}</span>
      <span style={{ fontFamily: mono ? 'monospace' : undefined, fontSize: mono ? 12 : 13 }}>
        {value}
      </span>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const modal: React.CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 12,
  padding: 24,
  width: 520,
  maxWidth: '90vw',
};

const warningBox: React.CSSProperties = {
  background: 'rgba(229, 138, 60, 0.12)',
  border: '1px solid rgba(229, 138, 60, 0.4)',
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
};

const infoBox: React.CSSProperties = {
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
  fontSize: 13,
  color: 'var(--color-muted)',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--color-surface-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: 'var(--color-text)',
  fontSize: 13,
  fontFamily: 'inherit',
  resize: 'vertical',
};

const primaryBtn: React.CSSProperties = {
  padding: '8px 16px',
  background: 'var(--color-accent)',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  fontWeight: 600,
};

const secondaryBtn: React.CSSProperties = {
  padding: '8px 16px',
  background: 'transparent',
  color: 'var(--color-muted)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
};

export type { RemediationTarget };
