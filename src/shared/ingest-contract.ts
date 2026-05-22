import { z } from 'zod';

/**
 * Contrato de ingestão usado pelo PowerShell ao postar em /api/v1/ingest.
 * É a fonte da verdade da forma do payload.
 */

export const SID_REGEX = /^S-\d+-\d+(-\d+)*$/;

export const SourceSchema = z.enum(['screenconnect', 'scheduled-task', 'manual']);
export type IngestSource = z.infer<typeof SourceSchema>;

export const ObjectClassSchema = z.enum(['User', 'Group', 'Unknown']);
export type ObjectClass = z.infer<typeof ObjectClassSchema>;

export const RawMemberSchema = z.object({
  sid: z.string().regex(SID_REGEX, 'SID inválido'),
  name: z.string().max(512).nullable().optional(),
  objectClass: ObjectClassSchema,
  resolved: z.boolean(),
});
export type RawMemberPayload = z.infer<typeof RawMemberSchema>;

export const MachineContextSchema = z.object({
  dnsHostName: z.string().min(1).max(255),
  netBiosName: z.string().min(1).max(64),
  domain: z.string().max(255).nullable(),
  biosSerial: z.string().max(128).nullable(),
  chassisUuid: z.string().max(64).nullable(),
  primaryMac: z.string().max(32).nullable(),
  osCaption: z.string().max(128).nullable(),
  osVersion: z.string().max(64).nullable(),
  osBuild: z.string().max(64).nullable(),
  lastBootAt: z.string().datetime({ offset: true }).nullable(),
  lastLoggedUser: z.string().max(255).nullable(),
  ipAddresses: z.array(z.string().max(64)).max(16).default([]),
});
export type MachineContext = z.infer<typeof MachineContextSchema>;

export const IngestPayloadSchema = z.object({
  scanId: z.string().uuid('scanId deve ser UUID v4'),
  agentVersion: z.string().max(32),
  source: SourceSchema,
  collectedAt: z.string().datetime({ offset: true }),
  machine: MachineContextSchema,
  members: z.array(RawMemberSchema).max(500),
});
export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

/* ---------- Remediation: ações entregues no response do /ingest ---------- */

export const ActionKindSchema = z.enum(['REMOVE_FROM_LOCAL_ADMINS']);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const ActionSchema = z.object({
  id: z.string().uuid(),
  kind: ActionKindSchema,
  targetSid: z.string().regex(SID_REGEX),
  targetName: z.string().max(512).nullable(),
  targetIsGroup: z.boolean(),
});
export type ActionPayload = z.infer<typeof ActionSchema>;

export const IngestResponseSchema = z.object({
  scanId: z.string().uuid(),
  machineId: z.string().uuid(),
  duplicate: z.boolean().optional(),
  created: z.boolean().optional(),
  renamed: z.boolean().optional(),
  actions: z.array(ActionSchema).max(50).default([]),
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

/* ---------- Remediation: resultado postado pelo agente após executar ---------- */

export const ActionResultEnum = z.enum([
  'success',
  'refused_protected',
  'refused_last_admin',
  'refused_well_known',
  'not_found',
  'error',
]);
export type ActionResultKind = z.infer<typeof ActionResultEnum>;

export const ActionResultSchema = z.object({
  actionId: z.string().uuid(),
  result: ActionResultEnum,
  error: z.string().max(2000).nullable().optional(),
  collectedAt: z.string().datetime({ offset: true }),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const ActionResultPayloadSchema = z.object({
  scanId: z.string().uuid(),
  results: z.array(ActionResultSchema).max(50),
});
export type ActionResultPayload = z.infer<typeof ActionResultPayloadSchema>;
