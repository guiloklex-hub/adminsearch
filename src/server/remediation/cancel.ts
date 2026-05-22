import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@server/db/client.ts';
import { auditLog, remediationActions } from '@server/db/schema.ts';
import { PlanRefused } from '@server/remediation/plan.ts';

export interface CancelInput {
  actor: string;
  actionId: string;
  reason: string;
  requestIp?: string | null;
  userAgent?: string | null;
}

/**
 * Cancela uma ação pré-execução. Permitido em `planned`, `confirmed`, `dispatched`.
 * Em `dispatched` o agente pode já estar executando ou já ter executado — o
 * cancelamento aqui é best-effort (o resultado pode chegar depois e ser ignorado).
 */
export async function cancel(deps: { db: DbClient }, input: CancelInput): Promise<{ id: string }> {
  const result = await deps.db.db
    .update(remediationActions)
    .set({
      status: 'cancelled',
      cancelledBy: input.actor,
      cancelledAt: new Date(),
      cancelReason: input.reason,
    })
    .where(
      and(
        eq(remediationActions.id, input.actionId),
        inArray(remediationActions.status, ['planned', 'confirmed', 'dispatched']),
      ),
    )
    .returning({
      id: remediationActions.id,
      machineId: remediationActions.machineId,
      targetSid: remediationActions.targetSid,
    });

  if (result.length === 0) {
    throw new PlanRefused('Ação não encontrada ou já em estado final', 409);
  }

  const row = result[0];
  if (!row) throw new Error('inconsistente');

  await deps.db.db.insert(auditLog).values({
    actor: input.actor,
    action: 'remediation_cancel',
    details: {
      actionId: row.id,
      machineId: row.machineId,
      targetSid: row.targetSid,
      reason: input.reason,
    },
    ip: input.requestIp ?? null,
    userAgent: input.userAgent ?? null,
  });

  return row;
}
