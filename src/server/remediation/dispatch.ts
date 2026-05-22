import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@server/db/client.ts';
import { remediationActions } from '@server/db/schema.ts';
import type { ActionPayload } from '@shared/ingest-contract.ts';

/**
 * Lê todas as `remediation_actions` da máquina em status `confirmed`, marca
 * como `dispatched` (com `dispatched_scan_id` correlato) e retorna a lista
 * para anexar à resposta do /ingest.
 *
 * Limita-se a `maxPerDispatch` para conter raio de impacto se a Web UI for
 * comprometida — ações excedentes ficam para o próximo scan.
 *
 * Operação em UMA transação com `FOR UPDATE SKIP LOCKED` para tolerar duas
 * coletas concorrentes da mesma máquina.
 */
export async function dispatch(
  deps: { db: DbClient },
  args: { machineId: string; scanId: string; maxPerDispatch: number },
): Promise<ActionPayload[]> {
  return await deps.db.db.transaction(async (tx) => {
    const claim = await tx.execute(sql`
      WITH pick AS (
        SELECT id FROM remediation_actions
        WHERE machine_id = ${args.machineId}
          AND status = 'confirmed'
        ORDER BY confirmed_at ASC NULLS FIRST
        FOR UPDATE SKIP LOCKED
        LIMIT ${args.maxPerDispatch}
      )
      UPDATE remediation_actions ra
      SET status = 'dispatched',
          dispatched_at = now(),
          dispatched_scan_id = ${args.scanId}
      FROM pick
      WHERE ra.id = pick.id
      RETURNING ra.id, ra.target_sid, ra.target_name, ra.target_is_group;
    `);

    const rows = claim.rows as Array<{
      id: string;
      target_sid: string;
      target_name: string | null;
      target_is_group: boolean;
    }>;

    return rows.map((r) => ({
      id: r.id,
      kind: 'REMOVE_FROM_LOCAL_ADMINS' as const,
      targetSid: r.target_sid,
      targetName: r.target_name,
      targetIsGroup: r.target_is_group,
    }));
  });
}

export const _imports = { and, eq };
