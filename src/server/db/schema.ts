import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* ---------- Máquinas ---------- */

export const machines = pgTable(
  'machines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dnsHostName: text('dns_host_name').notNull(),
    netBiosName: text('net_bios_name').notNull(),
    domain: text('domain'),
    biosSerial: text('bios_serial'),
    chassisUuid: text('chassis_uuid'),
    primaryMac: text('primary_mac'),
    osCaption: text('os_caption'),
    osVersion: text('os_version'),
    osBuild: text('os_build'),
    lastBootAt: timestamp('last_boot_at', { withTimezone: true }),
    lastLoggedUser: text('last_logged_user'),
    ipAddresses: text('ip_addresses').array(),
    agentVersion: text('agent_version'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    notes: text('notes'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fqdnUnique: uniqueIndex('machines_fqdn_unique').on(t.dnsHostName),
    biosSerialIdx: index('machines_bios_serial_idx').on(t.biosSerial),
    chassisUuidIdx: index('machines_chassis_uuid_idx').on(t.chassisUuid),
    lastSeenIdx: index('machines_last_seen_idx').on(t.lastSeenAt),
  }),
);

/* ---------- Scan runs (uma execução do PS) ---------- */

export const scanRuns = pgTable(
  'scan_runs',
  {
    id: uuid('id').primaryKey(), // gerado pelo PS, idempotente
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull(), // 'screenconnect' | 'scheduled-task' | 'manual'
    agentVersion: text('agent_version'),
    totalRawMembers: integer('total_raw_members').notNull().default(0),
    rawPayload: jsonb('raw_payload').notNull(),
    expansionStatus: text('expansion_status').notNull().default('pending'), // pending | done | failed
    expansionError: text('expansion_error'),
    expansionStartedAt: timestamp('expansion_started_at', { withTimezone: true }),
    expansionFinishedAt: timestamp('expansion_finished_at', { withTimezone: true }),
  },
  (t) => ({
    machineCollectedIdx: index('scan_runs_machine_collected_idx').on(
      t.machineId,
      t.collectedAt.desc(),
    ),
    expansionPendingIdx: index('scan_runs_expansion_pending_idx').on(t.expansionStatus),
  }),
);

/* ---------- Raw members (snapshot do que o PS viu) ---------- */

export const rawMembers = pgTable(
  'raw_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanRunId: uuid('scan_run_id')
      .notNull()
      .references(() => scanRuns.id, { onDelete: 'cascade' }),
    sid: text('sid').notNull(),
    name: text('name'),
    objectClass: text('object_class').notNull(), // 'User' | 'Group' | 'Unknown'
    resolved: boolean('resolved').notNull(),
  },
  (t) => ({
    scanIdx: index('raw_members_scan_idx').on(t.scanRunId),
  }),
);

/* ---------- AD users (cache) ---------- */

export const adUsers = pgTable(
  'ad_users',
  {
    sid: text('sid').primaryKey(),
    samAccountName: text('sam_account_name'),
    userPrincipalName: text('user_principal_name'),
    displayName: text('display_name'),
    email: text('email'),
    department: text('department'),
    title: text('title'),
    managerDn: text('manager_dn'),
    distinguishedName: text('distinguished_name'),
    enabled: boolean('enabled'),
    passwordLastSet: timestamp('password_last_set', { withTimezone: true }),
    lastLogon: timestamp('last_logon', { withTimezone: true }),
    accountExpires: timestamp('account_expires', { withTimezone: true }),
    isServiceAccount: boolean('is_service_account').notNull().default(false),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    samIdx: index('ad_users_sam_idx').on(t.samAccountName),
    enabledIdx: index('ad_users_enabled_idx').on(t.enabled),
  }),
);

/* ---------- Effective members (pós-expansão) ---------- */

export const effectiveMembers = pgTable(
  'effective_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanRunId: uuid('scan_run_id')
      .notNull()
      .references(() => scanRuns.id, { onDelete: 'cascade' }),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    sid: text('sid').notNull(),
    name: text('name'),
    source: text('source').notNull(), // AD_USER | LOCAL_USER | WELL_KNOWN | ORPHAN_SID
    viaGroup: text('via_group'),
    viaGroupSid: text('via_group_sid'),
    adEnabled: boolean('ad_enabled'),
    isServiceAccount: boolean('is_service_account').notNull().default(false),
    severity: text('severity').notNull(), // critical | high | medium | low | info
    reasonCode: text('reason_code'), // nullable até o backfill rodar; depois NOT NULL
    matchedExceptionId: uuid('matched_exception_id'),
  },
  (t) => ({
    scanIdx: index('effective_members_scan_idx').on(t.scanRunId),
    machineIdx: index('effective_members_machine_idx').on(t.machineId, t.source),
    sidIdx: index('effective_members_sid_idx').on(t.sid),
    severityIdx: index('effective_members_severity_idx').on(t.severity),
    reasonIdx: index('effective_members_reason_idx').on(t.reasonCode),
  }),
);

/* ---------- Política de severidade (override global por motivo) ---------- */

export const severityPolicies = pgTable('severity_policies', {
  reasonCode: text('reason_code').primaryKey(),
  severityOverride: text('severity_override').notNull(), // critical|high|medium|low|info
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by').notNull(),
});

/* ---------- Eventos (diff entre scans consecutivos) ---------- */

export const findingsEvents = pgTable(
  'findings_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    scanRunId: uuid('scan_run_id').references(() => scanRuns.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').notNull(), // ADMIN_ADDED | ADMIN_REMOVED | MACHINE_RENAMED | ORPHAN_DETECTED
    sid: text('sid'),
    name: text('name'),
    details: jsonb('details'),
  },
  (t) => ({
    machineOccurredIdx: index('findings_events_machine_occurred_idx').on(
      t.machineId,
      t.occurredAt.desc(),
    ),
    kindOccurredIdx: index('findings_events_kind_occurred_idx').on(t.kind, t.occurredAt.desc()),
  }),
);

/* ---------- Exceções (whitelist) ---------- */

export const exceptions = pgTable(
  'exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').notNull(), // 'global' | 'machine' | 'tag'
    scopeValue: text('scope_value'), // machine.id ou tag string; null se global
    matchKind: text('match_kind').notNull(), // 'sid' | 'sam' | 'group'
    matchValue: text('match_value').notNull(),
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => ({
    scopeIdx: index('exceptions_scope_idx').on(t.scope, t.scopeValue),
    matchIdx: index('exceptions_match_idx').on(t.matchKind, t.matchValue),
  }),
);

/* ---------- Admin login local ---------- */

export const admins = pgTable(
  'admins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(), // argon2id
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => ({
    usernameUnique: uniqueIndex('admins_username_unique').on(t.username),
  }),
);

/* ---------- Audit log ---------- */

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actor: text('actor'),
    action: text('action').notNull(),
    details: jsonb('details'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actorOccurredIdx: index('audit_log_actor_occurred_idx').on(t.actor, t.occurredAt.desc()),
    actionOccurredIdx: index('audit_log_action_occurred_idx').on(t.action, t.occurredAt.desc()),
  }),
);

/* ---------- Remediation actions (remoção do Administrators local) ---------- */

export const remediationActions = pgTable(
  'remediation_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),

    targetSid: text('target_sid').notNull(),
    targetName: text('target_name'),
    targetSource: text('target_source'), // AD_USER | LOCAL_USER | ORPHAN_SID
    targetIsGroup: boolean('target_is_group').notNull().default(false),
    viaGroup: text('via_group'),

    status: text('status').notNull().default('planned'),
    // planned | confirmed | cancelled | dispatched | executed | failed | refused

    plannedBy: text('planned_by').notNull(),
    plannedAt: timestamp('planned_at', { withTimezone: true }).notNull().defaultNow(),
    plannedReason: text('planned_reason'),

    confirmedBy: text('confirmed_by'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),

    cancelledBy: text('cancelled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),

    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    dispatchedScanId: uuid('dispatched_scan_id'),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    executionResult: text('execution_result'),
    executionError: text('execution_error'),
  },
  (t) => ({
    statusIdx: index('remediation_actions_status_idx').on(t.status),
    machineStatusIdx: index('remediation_actions_machine_status_idx').on(t.machineId, t.status),
    plannedAtIdx: index('remediation_actions_planned_at_idx').on(t.plannedAt.desc()),
  }),
);

/* ---------- Tipos auxiliares ---------- */

export type Machine = typeof machines.$inferSelect;
export type NewMachine = typeof machines.$inferInsert;

export type ScanRun = typeof scanRuns.$inferSelect;
export type NewScanRun = typeof scanRuns.$inferInsert;

export type RawMember = typeof rawMembers.$inferSelect;
export type EffectiveMember = typeof effectiveMembers.$inferSelect;
export type AdUser = typeof adUsers.$inferSelect;
export type FindingsEvent = typeof findingsEvents.$inferSelect;
export type Exception = typeof exceptions.$inferSelect;
export type Admin = typeof admins.$inferSelect;
export type RemediationAction = typeof remediationActions.$inferSelect;
export type NewRemediationAction = typeof remediationActions.$inferInsert;
