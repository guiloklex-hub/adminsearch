import type { CachedAdUser } from '@server/enricher/ad-user-cache.ts';
import { isExpandableWellKnownGroupSid, isWellKnownSid } from '@server/enricher/well-known.ts';

export type MemberSource = 'AD_USER' | 'LOCAL_USER' | 'WELL_KNOWN' | 'ORPHAN_SID';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

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
 * Classificação de severidade:
 *
 * - `info`: coberto por exception ativa (validado).
 *
 * - `low`: built-in do Windows ou herança via grupo institucional. O
 *   operador raramente precisa agir aqui — esse é o estado esperado.
 *
 * - `medium`: situações que merecem revisão eventual:
 *   - SID nao resolvido (provavelmente bug de LDAP em grupos)
 *   - service accounts adicionadas direto
 *   - contas locais customizadas
 *
 * - `high`: requer atenção humana proxima:
 *   - AD user habilitado adicionado DIRETO em uma maquina (fora do grupo
 *     institucional)
 *   - AD user desabilitado herdando via grupo (basta tirar do grupo no AD
 *     para limpar varias maquinas)
 *   - AD user herdando via grupo built-in do dominio (Domain Admins etc) —
 *     admin de domínio na estação é genuinamente preocupante
 *
 * - `critical`: limpeza imediata necessária:
 *   - AD user desabilitado adicionado DIRETO (residuo de ex-funcionario
 *     ainda com privilegio nessa maquina especifica)
 *   - SID orfao adicionado DIRETO (conta deletada mas ainda admin)
 *   - Grupo built-in do dominio (Domain Admins) entrando em Administrators
 *     local diretamente — toda a equipe de TI vira admin do parque
 */
export function classifySeverity(input: SeverityInput): Severity {
  if (input.hasMatchedException) return 'info';

  // Built-in locais (BUILTIN\Administrators, NT AUTHORITY\SYSTEM) sempre low —
  // são esperados em qualquer máquina. Grupos do dominio com RID well-known
  // (Domain Admins, Enterprise Admins) NÃO entram aqui: caem nas regras
  // específicas abaixo.
  if (
    (input.source === 'WELL_KNOWN' || isWellKnownSid(input.sid)) &&
    !isExpandableWellKnownGroupSid(input.sid)
  ) {
    return 'low';
  }

  // Grupo built-in do dominio aparecendo direto em Administrators local —
  // critico. Toda a equipe de TI vira admin do parque sem auditoria.
  if (input.source === 'WELL_KNOWN' && isExpandableWellKnownGroupSid(input.sid)) {
    return 'critical';
  }

  const isDirect = input.viaGroup === null;
  const inheritedFromBuiltinDomainGroup =
    !isDirect && !!input.viaGroupSid && isExpandableWellKnownGroupSid(input.viaGroupSid);

  if (input.source === 'ORPHAN_SID') {
    // Direto: conta deletada mas ainda admin nominal → grave.
    // Via grupo: muito provavelmente um grupo do AD que o LDAP nao conseguiu
    // resolver (bug do filter binario / referrals). Nao e' ameaca real.
    return isDirect ? 'critical' : 'medium';
  }

  if (input.source === 'AD_USER') {
    const enabled = input.adUser?.enabled !== false; // null/undefined trata como habilitado
    const isService = input.adUser?.isServiceAccount === true;

    if (!enabled) {
      // Conta AD desabilitada ainda na lista de admins — sempre vale limpar.
      return isDirect ? 'critical' : 'high';
    }
    if (isService) {
      // Service accounts: direto vale revisar, via grupo geralmente esperado.
      // Via Domain Admins/Enterprise Admins ainda assim e' alto.
      if (inheritedFromBuiltinDomainGroup) return 'high';
      return isDirect ? 'medium' : 'low';
    }
    // Conta nominal habilitada — direto e' o caso que precisa ser
    // investigado; via grupo institucional e' o estado canonico, EXCETO
    // se o "grupo institucional" for built-in do dominio.
    if (inheritedFromBuiltinDomainGroup) return 'high';
    return isDirect ? 'high' : 'low';
  }

  if (input.source === 'LOCAL_USER') {
    // Contas locais customizadas (nao built-in) — sempre diretas por
    // natureza, mas o risco varia menos. Mantemos medium.
    return 'medium';
  }

  return 'medium';
}
