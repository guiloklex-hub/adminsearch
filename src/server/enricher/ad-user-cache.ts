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
    const result = new Map<string, CachedAdUser | null>();
    if (sids.length === 0) return result;

    const unique = Array.from(new Set(sids));
    const rows = await this.db.db
      .select()
      .from(adUsers)
      .where(inArray(adUsers.sid, unique));

    const cached = new Map<string, typeof rows[number]>();
    for (const r of rows) cached.set(r.sid, r);

    const now = Date.now();
    const toFetch: string[] = [];

    for (const sid of unique) {
      const row = cached.get(sid);
      if (!row || now - row.lastSyncedAt.getTime() > this.ttlMs) {
        toFetch.push(sid);
      } else {
        result.set(sid, this.fromRow(row));
      }
    }

    if (toFetch.length > 0) {
      const fetched = await this.fetchFromLdap(toFetch);
      for (const sid of toFetch) {
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

  private async fetchFromLdap(sids: string[]): Promise<Map<string, CachedAdUser>> {
    const out = new Map<string, CachedAdUser>();

    // Filtros (objectSid=...) em OR único — limita tamanho
    const chunks: string[][] = [];
    const chunkSize = 20;
    for (let i = 0; i < sids.length; i += chunkSize) {
      chunks.push(sids.slice(i, i + chunkSize));
    }

    for (const chunk of chunks) {
      const filter = `(|${chunk.map((s) => `(objectSid=${escapeSidForFilter(s)})`).join('')})`;
      const entries = await this.ldap
        .search<AdUserAttrs>(filter, USER_ATTRS)
        .catch(() => [] as AdUserAttrs[]);

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

    return out;
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
