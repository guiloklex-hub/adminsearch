/**
 * Tipos compartilhados pelo módulo de sync do diretório AD.
 *
 * O sync popula 3 tabelas (`ad_groups`, `ad_group_memberships`, `ad_users`
 * por UPSERT) com o catálogo completo do AD, separado do enricher de scans.
 */

export interface FetchedAdGroup {
  sid: string;
  distinguishedName: string;
  samAccountName: string | null;
  cn: string | null;
  displayName: string | null;
  description: string | null;
  groupType: number | null;
  isSecurity: boolean | null;
  scope: GroupScope | null;
  /** DNs declarados em `member` (membros diretos — usuários e grupos). */
  memberDns: string[];
}

export type GroupScope = 'global' | 'domain_local' | 'universal' | 'builtin';

export interface FetchedAdUser {
  sid: string;
  samAccountName: string | null;
  userPrincipalName: string | null;
  displayName: string | null;
  email: string | null;
  department: string | null;
  title: string | null;
  managerDn: string | null;
  distinguishedName: string;
  enabled: boolean;
  passwordLastSet: Date | null;
  lastLogon: Date | null;
  accountExpires: Date | null;
  isServiceAccount: boolean;
  /** DNs dos grupos diretos (memberOf não-transitivo). */
  directGroupDns: string[];
}

export interface FetchedGroupMembership {
  userSid: string;
  groupSid: string;
  isDirect: boolean;
}

export interface SyncSummary {
  syncId: string;
  usersTotal: number;
  groupsTotal: number;
  membershipsTotal: number;
  durationMs: number;
}

export type TriggerSource = 'scheduler' | 'boot' | `manual:${string}`;

export class SyncAlreadyRunningError extends Error {
  constructor() {
    super('Já existe um sync de diretório AD em execução.');
    this.name = 'SyncAlreadyRunningError';
  }
}
