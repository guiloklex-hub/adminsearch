export type SeverityKey = 'critical' | 'high' | 'medium' | 'low' | 'info';

const LABEL: Record<SeverityKey, string> = {
  critical: 'Crítico',
  high: 'Alto',
  medium: 'Médio',
  low: 'Baixo',
  info: 'Info',
};

const DESCRIPTION: Record<SeverityKey, string> = {
  critical:
    'Crítico — limpeza imediata: SID órfão direto, conta AD desabilitada direta, ou grupo built-in do domínio (Domain Admins, Enterprise Admins) direto em Administrators local.',
  high: 'Alto — requer atenção: AD habilitado adicionado direto na máquina, AD desabilitado herdado via grupo, ou herança via Domain Admins/Enterprise Admins.',
  medium:
    'Médio — revisar quando possível: service account direta, conta local customizada, ou SID não resolvido herdado via grupo (provável bug do LDAP).',
  low: 'Baixo — estado esperado: built-in local do Windows (BUILTIN\\Administrators, NT AUTHORITY\\SYSTEM) ou herança via grupo institucional.',
  info: 'Info — coberto por uma exception ativa (validado e silenciado em /settings).',
};

const COLORS: Record<SeverityKey, { bg: string; fg: string }> = {
  critical: { bg: 'rgba(229, 69, 69, 0.18)', fg: '#ff7a7a' },
  high: { bg: 'rgba(224, 138, 60, 0.18)', fg: '#f0a262' },
  medium: { bg: 'rgba(212, 181, 65, 0.18)', fg: '#e6cf6b' },
  low: { bg: 'rgba(91, 155, 229, 0.18)', fg: '#7ab2ff' },
  info: { bg: 'rgba(108, 116, 136, 0.18)', fg: '#a4abbf' },
};

export function SeverityBadge({
  value,
  description,
}: {
  value: string | null | undefined;
  description?: string;
}) {
  if (!value) {
    return <span style={{ color: 'var(--color-muted)' }}>—</span>;
  }
  const key = (value as SeverityKey) in LABEL ? (value as SeverityKey) : 'info';
  const c = COLORS[key];
  return (
    <span
      title={description ?? DESCRIPTION[key]}
      style={{
        background: c.bg,
        color: c.fg,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.2,
      }}
    >
      {LABEL[key]}
    </span>
  );
}
