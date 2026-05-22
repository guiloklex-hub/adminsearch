import type { CachedAdUser } from '@server/enricher/ad-user-cache.ts';
import { isWellKnownSid } from '@server/enricher/well-known.ts';

export type MemberSource = 'AD_USER' | 'LOCAL_USER' | 'WELL_KNOWN' | 'ORPHAN_SID';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SeverityInput {
  sid: string;
  source: MemberSource;
  hasMatchedException: boolean;
  adUser: CachedAdUser | null;
}

/**
 * Heurística de severidade documentada no plano. As entradas com `info` são
 * justamente as cobertas por exceções (whitelist), para que os filtros padrão
 * mostrem apenas o que requer ação.
 */
export function classifySeverity(input: SeverityInput): Severity {
  if (input.hasMatchedException) return 'info';

  if (input.source === 'ORPHAN_SID') return 'critical';
  if (input.source === 'WELL_KNOWN' || isWellKnownSid(input.sid)) return 'low';

  if (input.source === 'LOCAL_USER') return 'medium';

  if (input.source === 'AD_USER') {
    if (!input.adUser) return 'high';
    if (input.adUser.enabled === false) return 'critical';
    if (input.adUser.isServiceAccount) return 'medium';
    return 'high';
  }

  return 'medium';
}
