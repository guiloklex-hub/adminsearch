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

/**
 * RIDs do domínio que indicam **contas** sensíveis built-in.
 * (Administrator 500, Guest 501 — são users, não grupos)
 */
const DOMAIN_WELL_KNOWN_USER_RIDS: Record<number, string> = {
  500: 'Administrator (built-in)',
  501: 'Guest (built-in)',
};

/**
 * RIDs do domínio que indicam **grupos** sensíveis built-in. Esses grupos
 * existem no AD com membros reais — quando aparecem no Administrators local
 * de uma máquina, **devem ser expandidos via LDAP** para listar os usuários
 * que de fato ganham admin nessa máquina. Ter `Domain Admins` em todas as
 * estações é o caso clássico — a expansão revela quem está dentro.
 */
const DOMAIN_WELL_KNOWN_GROUP_RIDS: Record<number, string> = {
  512: 'Domain Admins',
  513: 'Domain Users',
  516: 'Domain Controllers',
  518: 'Schema Admins',
  519: 'Enterprise Admins',
  520: 'Group Policy Creator Owners',
};

const DOMAIN_WELL_KNOWN_RIDS: Record<number, string> = {
  ...DOMAIN_WELL_KNOWN_USER_RIDS,
  ...DOMAIN_WELL_KNOWN_GROUP_RIDS,
};

function domainRid(sid: string): number | null {
  const m = /^S-1-5-21-\d+-\d+-\d+-(\d+)$/.exec(sid);
  return m ? Number(m[1]) : null;
}

export function isWellKnownSid(sid: string): boolean {
  if (sid in STATIC_WELL_KNOWN) return true;
  const rid = domainRid(sid);
  return rid !== null && rid in DOMAIN_WELL_KNOWN_RIDS;
}

/**
 * Grupos built-in que vivem no AD (Domain Admins etc) — **devem ser
 * expandidos** ao aparecer em Administrators local. Built-in locais
 * (S-1-5-32-*) NÃO entram aqui: são coletâneas locais sem membros AD.
 */
export function isExpandableWellKnownGroupSid(sid: string): boolean {
  const rid = domainRid(sid);
  return rid !== null && rid in DOMAIN_WELL_KNOWN_GROUP_RIDS;
}

export function wellKnownName(sid: string): string | null {
  if (sid in STATIC_WELL_KNOWN) return STATIC_WELL_KNOWN[sid] ?? null;
  const rid = domainRid(sid);
  return rid !== null ? (DOMAIN_WELL_KNOWN_RIDS[rid] ?? null) : null;
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
