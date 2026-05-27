import type { LdapPool } from '@server/enricher/ldap-client.ts';
import { fileTimeToDate, sidBufferToString } from '@server/enricher/sid.ts';
import type { AppLogger } from '@server/logger.ts';
import type { FetchedAdGroup, FetchedAdUser, GroupScope } from './types.ts';

// ldapts pode retornar QUALQUER atributo como string OU string[] (inclusive
// para atributos declarados single-valued no schema do AD). Em alguns ADs
// também volta `[]` quando o atributo existe mas está vazio. Tipamos como
// `LdapValue` e normalizamos via `asString` antes de gravar — gravar `[]`
// numa coluna `text` do Postgres vira a string literal `"{}"` (formato
// textual de array Postgres) e aparece como `{}` na UI.
type LdapValue = string | string[] | undefined | null;

interface RawGroup {
  objectSid: Buffer;
  distinguishedName: LdapValue;
  sAMAccountName?: LdapValue;
  cn?: LdapValue;
  displayName?: LdapValue;
  description?: LdapValue;
  groupType?: string | number | string[];
  member?: LdapValue;
}

interface RawUser {
  objectSid: Buffer;
  sAMAccountName?: LdapValue;
  userPrincipalName?: LdapValue;
  displayName?: LdapValue;
  mail?: LdapValue;
  department?: LdapValue;
  title?: LdapValue;
  manager?: LdapValue;
  distinguishedName: LdapValue;
  userAccountControl?: string | number | string[];
  pwdLastSet?: string | string[];
  lastLogonTimestamp?: string | string[];
  accountExpires?: string | string[];
  memberOf?: LdapValue;
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
    const dn = asString(e.distinguishedName);
    if (!dn) continue; // sem DN não há como expandir; pula
    const gtRaw = asString(e.groupType);
    const groupType = gtRaw !== null ? Number.parseInt(gtRaw, 10) : null;
    const { isSecurity, scope } = classifyGroupType(groupType);
    out.push({
      sid,
      distinguishedName: dn,
      samAccountName: asString(e.sAMAccountName),
      cn: asString(e.cn),
      displayName: asString(e.displayName),
      description: asStringJoined(e.description, ' '),
      groupType,
      isSecurity,
      scope,
      memberDns: asStringArray(e.member),
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
    const dn = asString(e.distinguishedName);
    if (!dn) continue; // sem DN, não usamos
    const uacRaw = asString(e.userAccountControl);
    const uac = uacRaw !== null ? Number(uacRaw) : 0;
    const enabled = (uac & UAC_DISABLED) === 0;

    out.push({
      sid,
      samAccountName: asString(e.sAMAccountName),
      userPrincipalName: asString(e.userPrincipalName),
      displayName: asString(e.displayName),
      email: asString(e.mail),
      department: asString(e.department),
      title: asString(e.title),
      managerDn: asString(e.manager),
      distinguishedName: dn,
      enabled,
      passwordLastSet: fileTimeToDate(asString(e.pwdLastSet)),
      lastLogon: fileTimeToDate(asString(e.lastLogonTimestamp)),
      accountExpires: fileTimeToDate(asString(e.accountExpires)),
      isServiceAccount: detectServiceAccount(e),
      directGroupDns: asStringArray(e.memberOf),
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
  const sam = (asString(e.sAMAccountName) ?? '').toLowerCase();
  const dn = (asString(e.distinguishedName) ?? '').toLowerCase();
  if (sam.startsWith('svc-') || sam.startsWith('svc_') || sam.endsWith('-svc')) return true;
  if (dn.includes('ou=service accounts')) return true;
  if (dn.includes('ou=services')) return true;
  if (dn.includes('ou=svc')) return true;
  return false;
}

/**
 * Normaliza um valor de atributo LDAP (single ou multi-valued) para string|null.
 * - undefined/null → null
 * - string vazia/whitespace → null
 * - array vazio → null
 * - array com itens → primeiro item não-nulo
 * - outros tipos → String(v)
 *
 * Sem isso, gravar um array `[]` numa coluna text do Postgres vira a string
 * literal `"{}"` (formato textual de array Postgres), que aparece como `{}`
 * na UI.
 */
function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = asString(item);
      if (s !== null) return s;
    }
    return null;
  }
  // Buffer ou objeto inesperado — String(buf) volta hex, String(obj) volta
  // `[object Object]`. Em ambos os casos é melhor null que poluir o banco.
  return null;
}

function asStringArray(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (typeof v === 'string') return v.trim() === '' ? [] : [v];
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      const s = asString(item);
      if (s !== null) out.push(s);
    }
    return out;
  }
  return [];
}

function asStringJoined(v: unknown, sep: string): string | null {
  const arr = asStringArray(v);
  if (arr.length === 0) return null;
  return arr.join(sep);
}

// RFC 4515 — escapar apenas (), *, \ e NUL.
function escapeLdapValue(v: string): string {
  return v.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
