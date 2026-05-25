import type { DbClient } from '@server/db/client.ts';
import { institutionalGroups } from '@server/db/schema.ts';

export interface InstitutionalGroup {
  sid: string;
  displayName: string;
  samAccountName: string | null;
}

/**
 * Cache em memória dos grupos institucionais cadastrados. Carregado on demand
 * e invalidado pelos endpoints PUT/DELETE em `institutional-groups.ts`.
 */
class InstitutionalGroupsCache {
  private map = new Map<string, InstitutionalGroup>();
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
    const rows = await this.db.db.select().from(institutionalGroups);
    const next = new Map<string, InstitutionalGroup>();
    for (const r of rows) {
      next.set(r.sid, {
        sid: r.sid,
        displayName: r.displayName,
        samAccountName: r.samAccountName,
      });
    }
    this.map = next;
    this.loaded = true;
  }

  invalidate(): void {
    this.loaded = false;
  }

  get(sid: string): InstitutionalGroup | undefined {
    return this.map.get(sid);
  }

  has(sid: string): boolean {
    return this.map.has(sid);
  }

  /** Set imutável de SIDs — passar para `classifyReason`. */
  sids(): ReadonlySet<string> {
    return new Set(this.map.keys());
  }
}

let instance: InstitutionalGroupsCache | null = null;

export function initInstitutionalGroupsCache(db: DbClient): InstitutionalGroupsCache {
  instance = new InstitutionalGroupsCache(db);
  return instance;
}

export function getInstitutionalGroupsCache(): InstitutionalGroupsCache {
  if (!instance) {
    throw new Error(
      'InstitutionalGroupsCache não inicializada — chamar initInstitutionalGroupsCache no boot',
    );
  }
  return instance;
}
