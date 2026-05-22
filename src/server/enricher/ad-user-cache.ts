import { eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@server/db/client.ts';
import { adUsers } from '@server/db/schema.ts';
import { escapeSidForFilter, fileTimeToDate, sidBufferToString } from '@server/enricher/sid.ts';
import type { LdapPool } from '@server/enricher/ldap-client.ts';

interface AdUserAttrs {
  objectSid: Buffer;
  sAMAccountName?: string;
  userPrincipalName?: string;
  displayName?: string;
  mail?: string;
  department?: string;
  title?: string;
  manager?: string;
  distinguishedName: string;
  userAccountControl?: string | number;
  pwdLastSet?: string;
  lastLogonTimestamp?: string;
  accountExpires?: string;
  objectClass?: string | string[];
}

const USER_ATTRS = [
  'objectSid',
  'sAMAccountName',
  'userPrincipalName',
  'displayName',
  'mail',
  'department',
  'title',
  'manager',
  'distinguishedName',
  'userAccountControl',
  'pwdLastSet',
  'lastLogonTimestamp',
  'accountExpires',
  'objectClass',
];

// UserAccountControl flag — ACCOUNTDISABLE = 2
const UAC_DISABLED = 0x0002;

// Escapa caracteres especiais de filter LDAP (RFC 4515 secao 3)
function escapeLdapValue(v: string): string {
  return v.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function isServiceAccount(attrs: AdUserAttrs): boolean {
  const sam = (attrs.sAMAccountName ?? '').toLowerCase();
  const dn = (attrs.distinguishedName ?? '').toLowerCase();
  if (sam.startsWith('svc-') || sam.startsWith('svc_') || sam.endsWith('-svc')) return true;
  if (dn.includes('ou=service accounts')) return true;
  if (dn.includes('ou=services')) return true;
  if (dn.includes('ou=svc')) return true;
  return false;
}

export interface CachedAdUser {
  sid: string;
  samAccountName: string | null;
  userPrincipalName: string | null;
  displayName: string | null;
  email: string | null;
  department: string | null;
  title: string | null;
  managerDn: string | null;
  distinguishedName: string | null;
  enabled: boolean | null;
  passwordLastSet: Date | null;
  lastLogon: Date | null;
  accountExpires: Date | null;
  isServiceAccount: boolean;
  lastSyncedAt: Date;
}

export class AdUserCache {
  constructor(
    private readonly db: DbClient,
    private readonly ldap: LdapPool,
    private readonly ttlMs: number,
  ) {}

  async getMany(sids: string[]): Promise<Map<string, CachedAdUser | null>> {
    return this.getManyWithHints(sids.map((sid) => ({ sid })));
  }

  /**
   * Versão com hints — quando o caller já sabe o sAMAccountName (vindo do
   * raw_member do agente ou do expand de grupo), passa junto. Se a busca
   * por (objectSid=binário) falhar (caso conhecido: ldapts vs binary attr),
   * fazemos fallback por (sAMAccountName=...).
   */
  async getManyWithHints(
    hints: Array<{ sid: string; samAccountName?: string | null }>,
  ): Promise<Map<string, CachedAdUser | null>> {
    const result = new Map<string, CachedAdUser | null>();
    if (hints.length === 0) return result;

    // Dedupe por SID, preservando o primeiro hint não-nulo
    const samBySid = new Map<string, string | null>();
    for (const h of hints) {
      if (!samBySid.has(h.sid)) samBySid.set(h.sid, h.samAccountName ?? null);
      else if (!samBySid.get(h.sid) && h.samAccountName) {
        samBySid.set(h.sid, h.samAccountName);
      }
    }
    const unique = Array.from(samBySid.keys());

    const rows = await this.db.db
      .select()
      .from(adUsers)
      .where(inArray(adUsers.sid, unique));

    const cached = new Map<string, typeof rows[number]>();
    for (const r of rows) cached.set(r.sid, r);

    const now = Date.now();
    const toFetch: Array<{ sid: string; sam: string | null }> = [];

    for (const sid of unique) {
      const row = cached.get(sid);
      if (!row || now - row.lastSyncedAt.getTime() > this.ttlMs) {
        toFetch.push({ sid, sam: samBySid.get(sid) ?? null });
      } else {
        result.set(sid, this.fromRow(row));
      }
    }

    if (toFetch.length > 0) {
      const fetched = await this.fetchFromLdap(toFetch);
      for (const { sid } of toFetch) {
        const value = fetched.get(sid) ?? null;
        result.set(sid, value);
      }
    }

    return result;
  }

  async getOne(sid: string): Promise<CachedAdUser | null> {
    const m = await this.getMany([sid]);
    return m.get(sid) ?? null;
  }

  async forceResync(sid: string): Promise<CachedAdUser | null> {
    await this.db.db.delete(adUsers).where(eq(adUsers.sid, sid));
    return this.getOne(sid);
  }

  private async fetchFromLdap(
    targets: Array<{ sid: string; sam: string | null }>,
  ): Promise<Map<string, CachedAdUser>> {
    const out = new Map<string, CachedAdUser>();

    // 1. Filtros (objectSid=...) em OR único — limita tamanho
    const chunks: Array<Array<{ sid: string; sam: string | null }>> = [];
    const chunkSize = 20;
    for (let i = 0; i < targets.length; i += chunkSize) {
      chunks.push(targets.slice(i, i + chunkSize));
    }

    for (const chunk of chunks) {
      const filter = `(|${chunk.map((t) => `(objectSid=${escapeSidForFilter(t.sid)})`).join('')})`;
      const entries = await this.ldap
        .search<AdUserAttrs>(filter, USER_ATTRS)
        .catch(() => [] as AdUserAttrs[]);

      await this.processEntries(entries, out);
    }

    // 2. Fallback por sAMAccountName para SIDs que NÃO casaram via objectSid
    //    (acontece quando o ldapts vs binary attr não cooperam em alguns ADs).
    const missingWithSam = targets.filter(
      (t) => !out.has(t.sid) && t.sam && t.sam.trim() !== '',
    );
    if (missingWithSam.length > 0) {
      const samChunks: Array<Array<{ sid: string; sam: string }>> = [];
      for (let i = 0; i < missingWithSam.length; i += chunkSize) {
        samChunks.push(
          missingWithSam.slice(i, i + chunkSize).map((t) => ({ sid: t.sid, sam: t.sam as string })),
        );
      }
      for (const chunk of samChunks) {
        const filter = `(|${chunk
          .map((t) => `(sAMAccountName=${escapeLdapValue(t.sam)})`)
          .join('')})`;
        const entries = await this.ldap
          .search<AdUserAttrs>(filter, USER_ATTRS)
          .catch(() => [] as AdUserAttrs[]);
        await this.processEntries(entries, out);
      }
    }

    return out;
  }

  private async processEntries(
    entries: AdUserAttrs[],
    out: Map<string, CachedAdUser>,
  ): Promise<void> {
    for (const e of entries) {
      if (!e.objectSid) continue;
      const sid = sidBufferToString(Buffer.from(e.objectSid));
      const uac = Number(e.userAccountControl ?? 0);
      const enabled = (uac & UAC_DISABLED) === 0;

      const cached: CachedAdUser = {
        sid,
        samAccountName: e.sAMAccountName ?? null,
        userPrincipalName: e.userPrincipalName ?? null,
        displayName: e.displayName ?? null,
        email: e.mail ?? null,
        department: e.department ?? null,
        title: e.title ?? null,
        managerDn: e.manager ?? null,
        distinguishedName: e.distinguishedName ?? null,
        enabled,
        passwordLastSet: fileTimeToDate(e.pwdLastSet),
        lastLogon: fileTimeToDate(e.lastLogonTimestamp),
        accountExpires: fileTimeToDate(e.accountExpires),
        isServiceAccount: isServiceAccount(e),
        lastSyncedAt: new Date(),
      };

      out.set(sid, cached);

      await this.db.db
        .insert(adUsers)
        .values({
          sid: cached.sid,
          samAccountName: cached.samAccountName,
          userPrincipalName: cached.userPrincipalName,
          displayName: cached.displayName,
          email: cached.email,
          department: cached.department,
          title: cached.title,
          managerDn: cached.managerDn,
          distinguishedName: cached.distinguishedName,
          enabled: cached.enabled,
          passwordLastSet: cached.passwordLastSet,
          lastLogon: cached.lastLogon,
          accountExpires: cached.accountExpires,
          isServiceAccount: cached.isServiceAccount,
          lastSyncedAt: cached.lastSyncedAt,
        })
        .onConflictDoUpdate({
          target: adUsers.sid,
          set: {
            samAccountName: cached.samAccountName,
            userPrincipalName: cached.userPrincipalName,
            displayName: cached.displayName,
            email: cached.email,
            department: cached.department,
            title: cached.title,
            managerDn: cached.managerDn,
            distinguishedName: cached.distinguishedName,
            enabled: cached.enabled,
            passwordLastSet: cached.passwordLastSet,
            lastLogon: cached.lastLogon,
            accountExpires: cached.accountExpires,
            isServiceAccount: cached.isServiceAccount,
            lastSyncedAt: cached.lastSyncedAt,
          },
        });
    }
  }

  private fromRow(row: typeof adUsers.$inferSelect): CachedAdUser {
    return {
      sid: row.sid,
      samAccountName: row.samAccountName,
      userPrincipalName: row.userPrincipalName,
      displayName: row.displayName,
      email: row.email,
      department: row.department,
      title: row.title,
      managerDn: row.managerDn,
      distinguishedName: row.distinguishedName,
      enabled: row.enabled,
      passwordLastSet: row.passwordLastSet,
      lastLogon: row.lastLogon,
      accountExpires: row.accountExpires,
      isServiceAccount: row.isServiceAccount,
      lastSyncedAt: row.lastSyncedAt,
    };
  }
}
