import { and, eq } from 'drizzle-orm';
import type { DbClient } from '@server/db/client.ts';
import { auditLog, remediationActions } from '@server/db/schema.ts';
import { PlanRefused } from '@server/remediation/plan.ts';

export interface ConfirmInput {
  actor: string;
  actionId: string;
  requestIp?: string | null;
  userAgent?: string | null;
}

/**
 * Transição `planned → confirmed`. Estritamente unidirecional — só de planned.
 * Confirmar uma ação já em outro estado retorna 409.
 */
export async function confirm(
  deps: { db: DbClient },
  input: ConfirmInput,
): Promise<{ id: string; status: string }> {
  const result = await deps.db.db
    .update(remediationActions)
    .set({
      status: 'confirmed',
      confirmedBy: input.actor,
      confirmedAt: new Date(),
    })
    .where(
      and(
        eq(remediationActions.id, input.actionId),
        eq(remediationActions.status, 'planned'),
      ),
    )
    .returning({
      id: remediationActions.id,
      status: remediationActions.status,
      machineId: remediationActions.machineId,
      targetSid: remediationActions.targetSid,
    });

  if (result.length === 0) {
    throw new PlanRefused('Ação não encontrada ou já não está em "planned"', 409);
  }

  const row = result[0];
  if (!row) throw new Error('inconsistente');

  await deps.db.db.insert(auditLog).values({
    actor: input.actor,
    action: 'remediation_confirm',
    details: {
      actionId: row.id,
      machineId: row.machineId,
      targetSid: row.targetSid,
    },
    ip: input.requestIp ?? null,
    userAgent: input.userAgent ?? null,
  });

  return row;
}
