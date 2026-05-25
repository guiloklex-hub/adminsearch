import type { DbClient } from '@server/db/client.ts';
import { auditLog } from '@server/db/schema.ts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/**
 * Reprocessamento administrativo: força o enricher a refazer o último scan
 * de cada máquina com cache LDAP limpo. Operação destrutiva (mas
 * automaticamente reversível ao próximo enricher run): apaga estados
 * derivados (`effective_members`, `findings_events` de admin, `ad_users`) e
 * marca o último `scan_run` por máquina como `pending`.
 *
 * Não toca em:
 *   - `machines` (identidade), `scan_runs` (histórico) — só muda status do mais
 *     recente.
 *   - `raw_members` (dado bruto vindo do agente).
 *   - `exceptions`, `severity_policies`, `institutional_groups`, `audit_log`.
 *
 * Ordem dentro da transação (atômica):
 *   1. DELETE FROM ad_users        -- limpa cache LDAP → re-resolve via LDAP
 *   2. DELETE effective_members do último scan/máquina  -- vão ser recriados
 *   3. DELETE findings_events de tipo admin             -- vão ser recriados
 *   4. UPDATE scan_runs do último/máquina → pending     -- gatilho do enricher
 */
export async function registerAdminReprocessRoutes(
  app: FastifyInstance,
  deps: { db: DbClient },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  app.post('/api/v1/admin/reprocess-all', async (req, reply) => {
    const username = req.user.username;

    const result = await deps.db.db.transaction(async (tx) => {
      // 1. Limpa cache LDAP — força o enricher a re-buscar atributos no AD
      const adUsersResult = await tx.execute(sql`DELETE FROM ad_users`);

      // 2. Apaga effective_members do último scan "done" de cada máquina
      const effectiveResult = await tx.execute(sql`
        WITH latest AS (
          SELECT DISTINCT ON (machine_id) id
          FROM scan_runs
          WHERE expansion_status = 'done'
          ORDER BY machine_id, collected_at DESC
        )
        DELETE FROM effective_members
        WHERE scan_run_id IN (SELECT id FROM latest)
      `);

      // 3. Apaga eventos de admin (vão ser recriados pelo diff do próximo run)
      const eventsResult = await tx.execute(sql`
        DELETE FROM findings_events
        WHERE kind IN ('ADMIN_ADDED', 'ADMIN_REMOVED', 'ORPHAN_DETECTED')
      `);

      // 4. Reabre o último scan de cada máquina para o enricher pegar
      const scansResult = await tx.execute(sql`
        WITH latest AS (
          SELECT DISTINCT ON (machine_id) id
          FROM scan_runs
          WHERE expansion_status = 'done'
          ORDER BY machine_id, collected_at DESC
        )
        UPDATE scan_runs
        SET expansion_status = 'pending', expansion_error = NULL
        WHERE id IN (SELECT id FROM latest)
      `);

      return {
        adUsersDeleted: adUsersResult.rowCount ?? 0,
        effectiveMembersDeleted: effectiveResult.rowCount ?? 0,
        findingsEventsDeleted: eventsResult.rowCount ?? 0,
        scansMarkedPending: scansResult.rowCount ?? 0,
      };
    });

    await deps.db.db.insert(auditLog).values({
      actor: username,
      action: 'admin_reprocess_all',
      details: result,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });

    reply.send({ ok: true, ...result });
  });
}
