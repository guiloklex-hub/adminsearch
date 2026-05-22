/**
 * SIDs well-known/built-in que aparecem em Administrators. Quase nunca representam
 * risco em si — devem cair em `severity=low` por padrão.
 *
 * Lista incompleta de propósito; só os que costumam aparecer no grupo.
 * Referência: https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers
 */
const STATIC_WELL_KNOWN: Record<string, string> = {
  'S-1-5-32-544': 'BUILTIN\\Administrators',
  'S-1-5-32-545': 'BUILTIN\\Users',
  'S-1-5-32-547': 'BUILTIN\\Power Users',
  'S-1-5-32-551': 'BUILTIN\\Backup Operators',
  'S-1-5-18': 'NT AUTHORITY\\SYSTEM',
  'S-1-5-19': 'NT AUTHORITY\\LOCAL SERVICE',
  'S-1-5-20': 'NT AUTHORITY\\NETWORK SERVICE',
  'S-1-5-4': 'NT AUTHORITY\\INTERACTIVE',
  'S-1-5-11': 'NT AUTHORITY\\Authenticated Users',
};

/** RIDs do domínio que indicam contas/grupos sensíveis embutidos. */
const DOMAIN_WELL_KNOWN_RIDS: Record<number, string> = {
  500: 'Administrator (built-in)',
  501: 'Guest (built-in)',
  512: 'Domain Admins',
  513: 'Domain Users',
  516: 'Domain Controllers',
  518: 'Schema Admins',
  519: 'Enterprise Admins',
  520: 'Group Policy Creator Owners',
};

export function isWellKnownSid(sid: string): boolean {
  if (sid in STATIC_WELL_KNOWN) return true;
  const m = /^S-1-5-21-\d+-\d+-\d+-(\d+)$/.exec(sid);
  if (!m) return false;
  const rid = Number(m[1]);
  return rid in DOMAIN_WELL_KNOWN_RIDS;
}

export function wellKnownName(sid: string): string | null {
  if (sid in STATIC_WELL_KNOWN) return STATIC_WELL_KNOWN[sid] ?? null;
  const m = /^S-1-5-21-\d+-\d+-\d+-(\d+)$/.exec(sid);
  if (!m) return null;
  const rid = Number(m[1]);
  return DOMAIN_WELL_KNOWN_RIDS[rid] ?? null;
}

/**
 * Built-in `Administrators` group local — SID well-known.
 */
export const LOCAL_ADMINS_GROUP_SID = 'S-1-5-32-544';

/**
 * SIDs no formato "S-1-5-21-..." são SIDs de domínio ou conta local
 * (o "21" indica que há um identifier authority + RID).
 */
export function isDomainOrLocalAccountSid(sid: string): boolean {
  return /^S-1-5-21-/.test(sid);
}
