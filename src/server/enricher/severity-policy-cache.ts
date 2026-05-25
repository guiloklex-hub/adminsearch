import type { DbClient } from '@server/db/client.ts';
import { severityPolicies } from '@server/db/schema.ts';
import {
  DEFAULT_SEVERITY_BY_REASON,
  REASON_CODES,
  type ReasonCode,
  type Severity,
} from '@server/enricher/severity.ts';

/**
 * Cache em memória dos overrides de severidade por motivo. Recarregado on
 * demand a partir de `severity_policies` e invalidado pelos endpoints PUT /
 * DELETE em `severity-policies.ts`. Como a tabela tem no máximo
 * `REASON_CODES.length` (~15) linhas, o reload completo é trivial.
 */
class SeverityPolicyCache {
  private map = new Map<ReasonCode, Severity>();
  private loaded = false;
  private inflight: Promise<void> | null = null;

  constructor(private readonly db: DbClient) {}

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.reload().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  async reload(): Promise<void> {
    const rows = await this.db.db.select().from(severityPolicies);
    const next = new Map<ReasonCode, Severity>();
    const validCodes = new Set<string>(REASON_CODES);
    for (const r of rows) {
      if (validCodes.has(r.reasonCode)) {
        next.set(r.reasonCode as ReasonCode, r.severityOverride as Severity);
      }
    }
    this.map = next;
    this.loaded = true;
  }

  invalidate(): void {
    this.loaded = false;
  }

  /** Devolve o nível efetivo para um motivo, aplicando override se houver. */
  resolve(reasonCode: ReasonCode): Severity {
    return this.map.get(reasonCode) ?? DEFAULT_SEVERITY_BY_REASON[reasonCode];
  }

  /** Snapshot do estado atual para o GET da rota. */
  snapshot(): Map<ReasonCode, Severity> {
    return new Map(this.map);
  }
}

let instance: SeverityPolicyCache | null = null;

export function initSeverityPolicyCache(db: DbClient): SeverityPolicyCache {
  instance = new SeverityPolicyCache(db);
  return instance;
}

export function getSeverityPolicyCache(): SeverityPolicyCache {
  if (!instance) {
    throw new Error(
      'SeverityPolicyCache não inicializada — chamar initSeverityPolicyCache no boot',
    );
  }
  return instance;
}
