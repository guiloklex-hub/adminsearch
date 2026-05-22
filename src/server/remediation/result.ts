import { and, eq } from 'drizzle-orm';
import type { DbClient } from '@server/db/client.ts';
import { auditLog, findingsEvents, remediationActions } from '@server/db/schema.ts';
import type { ActionResult, ActionResultKind } from '@shared/ingest-contract.ts';

const SUCCESS_RESULTS: ReadonlySet<ActionResultKind> = new Set(['success']);
const FINAL_REFUSE: ReadonlySet<ActionResultKind> = new Set([
  'refused_protected',
  'refused_last_admin',
  'refused_well_known',
]);

function statusFor(result: ActionResultKind): string {
  if (SUCCESS_RESULTS.has(result)) return 'executed';
  if (FINAL_REFUSE.has(result)) return 'refused';
  return 'failed';
}

/**
 * Processa um lote de resultados do agente. Anti-replay: só aceita transições
 * a partir de `dispatched` com `dispatched_scan_id` casando com o `scanId` do
 * payload. Resultados antigos ou repetidos viram no-op.
 */
export async function applyResults(
  deps: { db: DbClient; agentIp?: string | null; userAgent?: string | null },
  scanId: string,
  results: ActionResult[],
): Promise<{ applied: number; ignored: number }> {
  let applied = 0;
  let ignored = 0;

  for (const r of results) {
    const newStatus = statusFor(r.result);
    const collectedAt = new Date(r.collectedAt);

    const updateResult = await deps.db.db
      .update(remediationActions)
      .set({
        status: newStatus,
        executedAt: collectedAt,
        executionResult: r.result,
        executionError: r.error ?? null,
      })
      .where(
        and(
          eq(remediationActions.id, r.actionId),
          eq(remediationActions.status, 'dispatched'),
          eq(remediationActions.dispatchedScanId, scanId),
        ),
      )
      .returning({
        id: remediationActions.id,
        machineId: remediationActions.machineId,
        targetSid: remediationActions.targetSid,
        targetName: remediationActions.targetName,
        confirmedBy: remediationActions.confirmedBy,
      });

    if (updateResult.length === 0) {
      ignored++;
      continue;
    }
    applied++;
    const row = updateResult[0];
    if (!row) continue;

    if (r.result === 'success') {
      await deps.db.db.insert(findingsEvents).values({
        machineId: row.machineId,
        scanRunId: scanId,
        kind: 'ADMIN_REMOVED',
        sid: row.targetSid,
        name: row.targetName,
        details: {
          removedBy: 'remediation',
          actionId: row.id,
          confirmedBy: row.confirmedBy,
        },
      });
    }

    await deps.db.db.insert(auditLog).values({
      actor: 'agent',
      action: 'remediation_result',
      details: {
        actionId: row.id,
        machineId: row.machineId,
        targetSid: row.targetSid,
        result: r.result,
        error: r.error ?? null,
      },
      ip: deps.agentIp ?? null,
      userAgent: deps.userAgent ?? null,
    });
  }

  return { applied, ignored };
}
