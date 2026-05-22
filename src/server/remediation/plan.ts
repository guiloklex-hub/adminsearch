import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbClient } from '@server/db/client.ts';
import {
  auditLog,
  effectiveMembers,
  exceptions,
  machines,
  remediationActions,
  scanRuns,
} from '@server/db/schema.ts';
import { isWellKnownSid } from '@server/enricher/well-known.ts';

export class PlanRefused extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export interface PlanInput {
  actor: string;
  machineId: string;
  targetSid: string;
  reason: string | null;
  requestIp?: string | null;
  userAgent?: string | null;
}

export interface PlanResult {
  id: string;
  status: string;
}

/**
 * Cria uma `remediation_actions(status='planned')` validando todas as travas:
 *  - SID não pode ser well-known (BUILTIN, Domain Admins, etc).
 *  - SID não pode estar coberto por uma exception ativa.
 *  - Precisa ter aparecido na última scan `done` da máquina.
 *  - Não pode já existir ação ativa (planned/confirmed/dispatched) para o par.
 */
export async function plan(deps: { db: DbClient }, input: PlanInput): Promise<PlanResult> {
  const { db } = deps;

  // 1. Máquina existe
  const machine = await db.db.query.machines.findFirst({
    where: eq(machines.id, input.machineId),
    columns: { id: true, tags: true, dnsHostName: true },
  });
  if (!machine) throw new PlanRefused('Máquina não encontrada', 404);

  // 2. Recusa SID well-known
  if (isWellKnownSid(input.targetSid)) {
    throw new PlanRefused(
      'SID é built-in / well-known e nunca será removido pelo sistema',
      400,
    );
  }

  // 3. Última scan done com o SID presente em effective_members
  const lastScan = await db.db.query.scanRuns.findFirst({
    where: and(eq(scanRuns.machineId, machine.id), eq(scanRuns.expansionStatus, 'done')),
    orderBy: [desc(scanRuns.collectedAt)],
  });
  if (!lastScan) {
    throw new PlanRefused(
      'Nenhum scan completo desta máquina ainda — aguarde a próxima coleta',
      409,
    );
  }

  const member = await db.db.query.effectiveMembers.findFirst({
    where: and(
      eq(effectiveMembers.scanRunId, lastScan.id),
      eq(effectiveMembers.sid, input.targetSid),
    ),
  });
  if (!member) {
    throw new PlanRefused(
      'O SID não aparece nos administradores efetivos da última coleta',
      409,
    );
  }

  // 4. Verifica se está coberto por exception ativa
  const now = new Date();
  const exceptionsRows = await db.db
    .select()
    .from(exceptions)
    .where(
      and(
        sql`(${exceptions.expiresAt} IS NULL OR ${exceptions.expiresAt} > ${now.toISOString()})`,
        inArray(exceptions.matchKind, ['sid', 'sam', 'group']),
      ),
    );

  const samToMatch = member.name ?? '';
  const groupToMatch = member.viaGroup ?? '';
  const groupSidToMatch = member.viaGroupSid ?? '';
  const tags = machine.tags ?? [];

  const covered = exceptionsRows.find((e) => {
    const scopeOk =
      e.scope === 'global' ||
      (e.scope === 'machine' && e.scopeValue === machine.id) ||
      (e.scope === 'tag' && e.scopeValue && tags.includes(e.scopeValue));
    if (!scopeOk) return false;
    if (e.matchKind === 'sid' && e.matchValue === input.targetSid) return true;
    if (e.matchKind === 'sam' && samToMatch && e.matchValue === samToMatch) return true;
    if (
      e.matchKind === 'group' &&
      (e.matchValue === groupToMatch || e.matchValue === groupSidToMatch)
    )
      return true;
    return false;
  });

  if (covered) {
    throw new PlanRefused(
      `SID coberto por exception "${covered.reason}" — remova a exception antes`,
      409,
    );
  }

  // 5. Cria registro — índice único parcial garante idempotência
  let inserted: { id: string; status: string };
  try {
    const [row] = await db.db
      .insert(remediationActions)
      .values({
        machineId: machine.id,
        targetSid: input.targetSid,
        targetName: member.name,
        targetSource: member.source,
        targetIsGroup: false, // Sempre user — viaGroup informa origem mas alvo é o user efetivo
        viaGroup: member.viaGroup,
        status: 'planned',
        plannedBy: input.actor,
        plannedReason: input.reason,
      })
      .returning({ id: remediationActions.id, status: remediationActions.status });
    if (!row) throw new Error('insert sem retorno');
    inserted = row;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new PlanRefused('Já existe uma ação ativa para este alvo nesta máquina', 409);
    }
    throw err;
  }

  await db.db.insert(auditLog).values({
    actor: input.actor,
    action: 'remediation_plan',
    details: {
      actionId: inserted.id,
      machineId: machine.id,
      hostName: machine.dnsHostName,
      targetSid: input.targetSid,
      reason: input.reason,
    },
    ip: input.requestIp ?? null,
    userAgent: input.userAgent ?? null,
  });

  return inserted;
}

export const _imports = { isNull, desc };
