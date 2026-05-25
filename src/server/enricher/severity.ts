import type { CachedAdUser } from '@server/enricher/ad-user-cache.ts';
import { isExpandableWellKnownGroupSid, isWellKnownSid } from '@server/enricher/well-known.ts';

export type MemberSource = 'AD_USER' | 'LOCAL_USER' | 'WELL_KNOWN' | 'ORPHAN_SID';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * Códigos estáveis que identificam cada caminho de classificação da
 * árvore de decisão abaixo. Servem de PK na tabela `severity_policies`
 * (override global por motivo) e ficam persistidos em `effective_members`
 * — toda mudança aqui é uma migration implícita.
 */
export const REASON_CODES = [
  'MATCHED_EXCEPTION',
  'BUILTIN_LOCAL',
  'BUILTIN_DOMAIN_GROUP_DIRECT',
  'ORPHAN_DIRECT',
  'ORPHAN_VIA_GROUP',
  'AD_DISABLED_DIRECT',
  'AD_DISABLED_VIA_GROUP',
  'AD_SERVICE_VIA_BUILTIN_DOMAIN_GROUP',
  'AD_SERVICE_DIRECT',
  'AD_SERVICE_VIA_GROUP',
  'AD_ENABLED_VIA_BUILTIN_DOMAIN_GROUP',
  'AD_ENABLED_DIRECT',
  'AD_ENABLED_VIA_GROUP',
  'LOCAL_USER',
  'FALLBACK',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Severidade default que o sistema atribui a cada motivo. */
export const DEFAULT_SEVERITY_BY_REASON: Record<ReasonCode, Severity> = {
  MATCHED_EXCEPTION: 'info',
  BUILTIN_LOCAL: 'low',
  BUILTIN_DOMAIN_GROUP_DIRECT: 'critical',
  ORPHAN_DIRECT: 'critical',
  ORPHAN_VIA_GROUP: 'medium',
  AD_DISABLED_DIRECT: 'critical',
  AD_DISABLED_VIA_GROUP: 'high',
  AD_SERVICE_VIA_BUILTIN_DOMAIN_GROUP: 'high',
  AD_SERVICE_DIRECT: 'medium',
  AD_SERVICE_VIA_GROUP: 'low',
  AD_ENABLED_VIA_BUILTIN_DOMAIN_GROUP: 'high',
  AD_ENABLED_DIRECT: 'high',
  AD_ENABLED_VIA_GROUP: 'low',
  LOCAL_USER: 'medium',
  FALLBACK: 'medium',
};

/**
 * Descrições estáticas dos motivos — sem interpolação dinâmica de
 * `viaGroup`. Usadas na página de Política de Severidade.
 *
 * Para a versão contextual (com nome do grupo concreto) use
 * `explainSeverity()`, que devolve a frase já interpolada.
 */
export const REASON_LABELS: Record<ReasonCode, { title: string; description: string }> = {
  MATCHED_EXCEPTION: {
    title: 'Coberto por exception',
    description: 'Combinação coberta por uma exception ativa em /settings — validado e silenciado.',
  },
  BUILTIN_LOCAL: {
    title: 'Built-in local do Windows',
    description:
      'BUILTIN\\Administrators, NT AUTHORITY\\SYSTEM e similares — estado esperado em qualquer estação.',
  },
  BUILTIN_DOMAIN_GROUP_DIRECT: {
    title: 'Grupo built-in do domínio direto em Administrators local',
    description:
      'Domain Admins, Enterprise Admins, etc. adicionados direto em Administrators local — toda a equipe de TI vira admin do parque sem auditoria.',
  },
  ORPHAN_DIRECT: {
    title: 'SID órfão adicionado direto',
    description:
      'SID não resolve no AD e foi adicionado direto ao Administrators local — conta deletada continua admin nominal nesta máquina.',
  },
  ORPHAN_VIA_GROUP: {
    title: 'SID órfão herdado via grupo',
    description:
      'SID não resolvido herdado via grupo — geralmente é um grupo do AD que o LDAP não conseguiu expandir (ruído, não ameaça real).',
  },
  AD_DISABLED_DIRECT: {
    title: 'Conta AD desabilitada adicionada direto',
    description:
      'Conta desativada no AD ainda admin direto na máquina — resíduo de ex-funcionário com privilégio.',
  },
  AD_DISABLED_VIA_GROUP: {
    title: 'Conta AD desabilitada herdando via grupo',
    description:
      'Conta desativada no AD ainda dentro de um grupo de admins — basta tirar do grupo no AD para limpar várias máquinas de uma vez.',
  },
  AD_SERVICE_VIA_BUILTIN_DOMAIN_GROUP: {
    title: 'Service account via grupo built-in do domínio',
    description:
      'Service account herdando admin via Domain Admins / Enterprise Admins — admin de domínio numa estação é genuinamente preocupante.',
  },
  AD_SERVICE_DIRECT: {
    title: 'Service account adicionada direto',
    description:
      'Service account adicionada direto na máquina — vale revisar se o privilégio é intencional.',
  },
  AD_SERVICE_VIA_GROUP: {
    title: 'Service account via grupo institucional',
    description:
      'Service account herdando admin via um grupo institucional comum — geralmente o padrão esperado.',
  },
  AD_ENABLED_VIA_BUILTIN_DOMAIN_GROUP: {
    title: 'Conta AD habilitada via grupo built-in do domínio',
    description:
      'Usuário habilitado herdando admin via Domain Admins / Enterprise Admins — admin de domínio na estação requer revisão.',
  },
  AD_ENABLED_DIRECT: {
    title: 'Conta AD habilitada adicionada direto',
    description:
      'Usuário habilitado no AD adicionado direto na máquina — fora do processo institucional, requer revisão.',
  },
  AD_ENABLED_VIA_GROUP: {
    title: 'Conta AD habilitada via grupo institucional',
    description:
      'Usuário habilitado herdando admin via grupo institucional — estado canônico do processo.',
  },
  LOCAL_USER: {
    title: 'Conta local customizada',
    description:
      'Conta local (não built-in) — não passa pelo controle do AD, vale revisar se ainda é necessária.',
  },
  FALLBACK: {
    title: 'Cenário não mapeado',
    description: 'Combinação fora das regras conhecidas — revisar manualmente.',
  },
};

export interface SeverityInput {
  sid: string;
  source: MemberSource;
  hasMatchedException: boolean;
  adUser: CachedAdUser | null;
  /**
   * Nome do grupo AD via o qual o user é admin local. `null` significa que
   * foi adicionado DIRETAMENTE ao Administrators local (sem passar por
   * grupo). Adições diretas sao tipicamente mais sensíveis: fogem do
   * processo institucional (grupo MM - Workstation Admins, etc) e indicam
   * intervenção manual em uma maquina especifica.
   */
  viaGroup: string | null;
  /**
   * SID do grupo via o qual o user herdou admin. Usado para detectar quando
   * o grupo é built-in do domínio (Domain Admins, Enterprise Admins) — esses
   * casos NÃO são "institucional baixo risco": são sérios por si só.
   */
  viaGroupSid?: string | null;
}

/**
 * Versão "achatada" dos sinais — corresponde 1:1 às colunas persistidas em
 * `effective_members`. Permite recomputar reasonCode/severity sem precisar
 * recarregar o `CachedAdUser`.
 */
export interface SeverityFlatInput {
  sid: string;
  source: MemberSource;
  viaGroup: string | null;
  viaGroupSid: string | null;
  adEnabled: boolean | null;
  isServiceAccount: boolean;
  hasMatchedException: boolean;
}

function toFlat(input: SeverityInput): SeverityFlatInput {
  return {
    sid: input.sid,
    source: input.source,
    viaGroup: input.viaGroup,
    viaGroupSid: input.viaGroupSid ?? null,
    adEnabled: input.adUser?.enabled ?? null,
    isServiceAccount: input.adUser?.isServiceAccount ?? false,
    hasMatchedException: input.hasMatchedException,
  };
}

/**
 * Árvore de decisão única — devolve o `reasonCode` correspondente ao caso.
 * Tanto `classifySeverity` quanto `explainSeverity` consomem essa função
 * pra manter as duas saídas sincronizadas.
 */
export function classifyReason(input: SeverityFlatInput): ReasonCode {
  if (input.hasMatchedException) return 'MATCHED_EXCEPTION';

  // Built-in locais (BUILTIN\Administrators, NT AUTHORITY\SYSTEM) — esperados.
  if (
    (input.source === 'WELL_KNOWN' || isWellKnownSid(input.sid)) &&
    !isExpandableWellKnownGroupSid(input.sid)
  ) {
    return 'BUILTIN_LOCAL';
  }

  // Grupo built-in do domínio direto em Administrators local.
  if (input.source === 'WELL_KNOWN' && isExpandableWellKnownGroupSid(input.sid)) {
    return 'BUILTIN_DOMAIN_GROUP_DIRECT';
  }

  const isDirect = input.viaGroup === null;
  const inheritedFromBuiltinDomainGroup =
    !isDirect && !!input.viaGroupSid && isExpandableWellKnownGroupSid(input.viaGroupSid);

  if (input.source === 'ORPHAN_SID') {
    return isDirect ? 'ORPHAN_DIRECT' : 'ORPHAN_VIA_GROUP';
  }

  if (input.source === 'AD_USER') {
    const enabled = input.adEnabled !== false; // null/undefined trata como habilitado
    const isService = input.isServiceAccount;

    if (!enabled) {
      return isDirect ? 'AD_DISABLED_DIRECT' : 'AD_DISABLED_VIA_GROUP';
    }
    if (isService) {
      if (inheritedFromBuiltinDomainGroup) return 'AD_SERVICE_VIA_BUILTIN_DOMAIN_GROUP';
      return isDirect ? 'AD_SERVICE_DIRECT' : 'AD_SERVICE_VIA_GROUP';
    }
    if (inheritedFromBuiltinDomainGroup) return 'AD_ENABLED_VIA_BUILTIN_DOMAIN_GROUP';
    return isDirect ? 'AD_ENABLED_DIRECT' : 'AD_ENABLED_VIA_GROUP';
  }

  if (input.source === 'LOCAL_USER') {
    return 'LOCAL_USER';
  }

  return 'FALLBACK';
}

/**
 * Classifica a severidade de um membro efetivo. Retorna o nível **default**
 * do sistema — não consulta políticas de override; o caller (enricher) é
 * que decide aplicar override via `resolveSeverity()` do cache.
 */
export function classifySeverity(input: SeverityInput): {
  severity: Severity;
  reasonCode: ReasonCode;
} {
  const reasonCode = classifyReason(toFlat(input));
  return { severity: DEFAULT_SEVERITY_BY_REASON[reasonCode], reasonCode };
}

/** Mesma coisa, mas a partir dos sinais achatados (sem CachedAdUser). */
export function classifySeverityFromRow(input: SeverityFlatInput): {
  severity: Severity;
  reasonCode: ReasonCode;
} {
  const reasonCode = classifyReason(input);
  return { severity: DEFAULT_SEVERITY_BY_REASON[reasonCode], reasonCode };
}

/**
 * Devolve a justificativa textual (em pt-BR) da severidade, interpolando
 * `viaGroup` real quando relevante. Para a forma estática (página de policy),
 * use `REASON_LABELS`.
 */
export function explainSeverity(input: SeverityFlatInput): string {
  const code = classifyReason(input);
  const viaGroup = input.viaGroup ?? '';

  switch (code) {
    case 'MATCHED_EXCEPTION':
      return 'Coberto por uma exception ativa — validado e silenciado em /settings.';
    case 'BUILTIN_LOCAL':
      return 'Built-in local do Windows (ex.: BUILTIN\\Administrators, NT AUTHORITY\\SYSTEM) — estado esperado.';
    case 'BUILTIN_DOMAIN_GROUP_DIRECT':
      return 'Grupo built-in do domínio (Domain Admins, Enterprise Admins, etc.) adicionado direto em Administrators local — toda a equipe de TI vira admin do parque sem auditoria.';
    case 'ORPHAN_DIRECT':
      return 'SID órfão adicionado direto: a conta foi deletada no AD mas continua como admin nominal nesta máquina.';
    case 'ORPHAN_VIA_GROUP':
      return 'SID não resolvido herdado via grupo — provavelmente um grupo do AD que o LDAP não conseguiu expandir (ruído, não ameaça real).';
    case 'AD_DISABLED_DIRECT':
      return 'Conta AD desabilitada adicionada direto — resíduo de ex-funcionário ainda com privilégio nesta máquina específica.';
    case 'AD_DISABLED_VIA_GROUP':
      return `Conta AD desabilitada ainda no grupo "${viaGroup}" — basta tirar do grupo no AD para limpar várias máquinas de uma vez.`;
    case 'AD_SERVICE_VIA_BUILTIN_DOMAIN_GROUP':
      return `Service account herdando via grupo built-in do domínio (${viaGroup}) — admin de domínio numa estação é genuinamente preocupante.`;
    case 'AD_SERVICE_DIRECT':
      return 'Service account adicionada direto — vale revisar se o privilégio nesta máquina específica é intencional.';
    case 'AD_SERVICE_VIA_GROUP':
      return `Service account herdando via grupo "${viaGroup}" — geralmente é o padrão esperado.`;
    case 'AD_ENABLED_VIA_BUILTIN_DOMAIN_GROUP':
      return `Conta AD habilitada herdando via grupo built-in do domínio (${viaGroup}) — admin de domínio na estação requer revisão.`;
    case 'AD_ENABLED_DIRECT':
      return 'Conta AD habilitada adicionada direto na máquina — fora do processo institucional, requer revisão.';
    case 'AD_ENABLED_VIA_GROUP':
      return `Conta AD habilitada herdando via grupo "${viaGroup}" — estado canônico do processo institucional.`;
    case 'LOCAL_USER':
      return 'Conta local customizada (não built-in) — não passa pelo controle do AD, vale revisar se ainda é necessária.';
    default:
      return 'Cenário fora das regras mapeadas — revisar manualmente.';
  }
}
