import type { LdapPool } from '@server/enricher/ldap-client.ts';
import { fileTimeToDate, sidBufferToString } from '@server/enricher/sid.ts';
import type { AppLogger } from '@server/logger.ts';
import type { FetchedAdGroup, FetchedAdUser, GroupScope } from './types.ts';

interface RawGroup {
  objectSid: Buffer;
  distinguishedName: string;
  sAMAccountName?: string;
  cn?: string;
  displayName?: string;
  description?: string | string[];
  groupType?: string | number;
  member?: string | string[];
}

interface RawUser {
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
  memberOf?: string | string[];
}

interface RawMemberSid {
  objectSid: Buffer;
}

// userAccountControl flags do AD
const UAC_DISABLED = 0x0002;

// groupType bits do AD (msdn)
const GROUP_TYPE_BUILTIN_LOCAL = 0x00000001;
const GROUP_TYPE_DOMAIN_LOCAL = 0x00000004;
const GROUP_TYPE_GLOBAL = 0x00000002;
const GROUP_TYPE_UNIVERSAL = 0x00000008;
const GROUP_TYPE_SECURITY_ENABLED = 0x80000000 | 0; // sign bit — força int32

const GROUP_ATTRS = [
  'objectSid',
  'distinguishedName',
  'sAMAccountName',
  'cn',
  'displayName',
  'description',
  'groupType',
  'member',
];

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
  'memberOf',
];

/**
 * Busca todos os grupos do AD via LDAP paginado (1000 por página).
 * Retorna metadados + a lista de DNs membros diretos (atributo `member`).
 */
export async function fetchAllGroups(
  ldap: LdapPool,
  pageSize: number,
  logger: AppLogger,
): Promise<FetchedAdGroup[]> {
  const entries = await ldap.searchPaged<RawGroup>('(objectClass=group)', GROUP_ATTRS, {
    pageSize,
  });
  logger.info({ count: entries.length }, 'ad-sync: fetchAllGroups concluído');

  const out: FetchedAdGroup[] = [];
  for (const e of entries) {
    if (!e.objectSid) continue;
    const sid = sidBufferToString(Buffer.from(e.objectSid));
    const groupType =
      e.groupType !== undefined && e.groupType !== null
        ? Number.parseInt(String(e.groupType), 10)
        : null;
    const { isSecurity, scope } = classifyGroupType(groupType);
    const memberRaw = e.member;
    const memberDns = !memberRaw ? [] : Array.isArray(memberRaw) ? memberRaw : [memberRaw];
    out.push({
      sid,
      distinguishedName: e.distinguishedName,
      samAccountName: e.sAMAccountName ?? null,
      cn: e.cn ?? null,
      displayName: e.displayName ?? null,
      description: Array.isArray(e.description) ? e.description.join(' ') : (e.description ?? null),
      groupType,
      isSecurity,
      scope,
      memberDns,
    });
  }
  return out;
}

/**
 * Busca todos os usuários do AD via LDAP paginado.
 * Inclui habilitados, desabilitados e service accounts (sem filtro de UAC).
 */
export async function fetchAllUsers(
  ldap: LdapPool,
  pageSize: number,
  logger: AppLogger,
): Promise<FetchedAdUser[]> {
  const entries = await ldap.searchPaged<RawUser>(
    '(&(objectCategory=person)(objectClass=user))',
    USER_ATTRS,
    { pageSize },
  );
  logger.info({ count: entries.length }, 'ad-sync: fetchAllUsers concluído');

  const out: FetchedAdUser[] = [];
  for (const e of entries) {
    if (!e.objectSid) continue;
    const sid = sidBufferToString(Buffer.from(e.objectSid));
    const uac = Number(e.userAccountControl ?? 0);
    const enabled = (uac & UAC_DISABLED) === 0;
    const memberOfRaw = e.memberOf;
    const directGroupDns = !memberOfRaw
      ? []
      : Array.isArray(memberOfRaw)
        ? memberOfRaw
        : [memberOfRaw];

    out.push({
      sid,
      samAccountName: e.sAMAccountName ?? null,
      userPrincipalName: e.userPrincipalName ?? null,
      displayName: e.displayName ?? null,
      email: e.mail ?? null,
      department: e.department ?? null,
      title: e.title ?? null,
      managerDn: e.manager ?? null,
      distinguishedName: e.distinguishedName,
      enabled,
      passwordLastSet: fileTimeToDate(e.pwdLastSet),
      lastLogon: fileTimeToDate(e.lastLogonTimestamp),
      accountExpires: fileTimeToDate(e.accountExpires),
      isServiceAccount: detectServiceAccount(e),
      directGroupDns,
    });
  }
  return out;
}

/**
 * Para um grupo dado, busca todos os usuários membros transitivos via
 * LDAP_MATCHING_RULE_IN_CHAIN. Server-side recursivo no AD — sem iteração
 * no app. Retorna apenas os SIDs (deduzimos `isDirect` no caller comparando
 * com os DNs diretos do user).
 */
export async function fetchGroupMembersTransitive(
  ldap: LdapPool,
  groupDn: string,
  pageSize: number,
): Promise<string[]> {
  const filter = `(&(objectCategory=person)(objectClass=user)(memberOf:1.2.840.113556.1.4.1941:=${escapeLdapValue(
    groupDn,
  )}))`;
  const entries = await ldap
    .searchPaged<RawMemberSid>(filter, ['objectSid'], { pageSize })
    .catch(() => [] as RawMemberSid[]);
  const sids: string[] = [];
  for (const e of entries) {
    if (!e.objectSid) continue;
    sids.push(sidBufferToString(Buffer.from(e.objectSid)));
  }
  return sids;
}

function classifyGroupType(groupType: number | null): {
  isSecurity: boolean | null;
  scope: GroupScope | null;
} {
  if (groupType === null) return { isSecurity: null, scope: null };
  const isSecurity = (groupType & GROUP_TYPE_SECURITY_ENABLED) !== 0;
  let scope: GroupScope | null = null;
  if ((groupType & GROUP_TYPE_BUILTIN_LOCAL) !== 0) scope = 'builtin';
  else if ((groupType & GROUP_TYPE_UNIVERSAL) !== 0) scope = 'universal';
  else if ((groupType & GROUP_TYPE_GLOBAL) !== 0) scope = 'global';
  else if ((groupType & GROUP_TYPE_DOMAIN_LOCAL) !== 0) scope = 'domain_local';
  return { isSecurity, scope };
}

function detectServiceAccount(e: RawUser): boolean {
  const sam = (e.sAMAccountName ?? '').toLowerCase();
  const dn = (e.distinguishedName ?? '').toLowerCase();
  if (sam.startsWith('svc-') || sam.startsWith('svc_') || sam.endsWith('-svc')) return true;
  if (dn.includes('ou=service accounts')) return true;
  if (dn.includes('ou=services')) return true;
  if (dn.includes('ou=svc')) return true;
  return false;
}

// RFC 4515 — escapar apenas (), *, \ e NUL.
function escapeLdapValue(v: string): string {
  return v.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
