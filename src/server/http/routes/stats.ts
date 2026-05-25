import type { DbClient } from '@server/db/client.ts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export async function registerStatsRoutes(
  app: FastifyInstance,
  deps: { db: DbClient; staleAgentDays: number },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  app.get('/api/v1/stats/dashboard', async (_req, reply) => {
    const staleCutoff = new Date(Date.now() - deps.staleAgentDays * 86400_000);
    const eventsCutoff = new Date(Date.now() - 24 * 3600_000);

    const dash = await deps.db.db.execute(sql`
      WITH latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id
        FROM scan_runs
        WHERE expansion_status = 'done'
        ORDER BY machine_id, collected_at DESC
      ),
      latest_findings AS (
        SELECT em.*
        FROM effective_members em
        JOIN latest_scan ls ON ls.id = em.scan_run_id
      ),
      pending_scans AS (
        SELECT COUNT(*)::int AS c FROM scan_runs WHERE expansion_status IN ('pending','processing','failed')
      )
      SELECT
        (SELECT COUNT(*)::int FROM machines) AS total_machines,
        (SELECT COUNT(*)::int FROM machines WHERE last_seen_at < ${staleCutoff.toISOString()}) AS stale_machines,
        (SELECT c FROM pending_scans) AS pending_scans,
        (SELECT COUNT(*)::int FROM latest_findings WHERE severity IN ('critical','high')) AS high_findings,
        (SELECT COUNT(*)::int FROM latest_findings WHERE severity = 'critical') AS critical_findings,
        (SELECT COUNT(*)::int FROM latest_findings WHERE source = 'ORPHAN_SID') AS orphan_findings,
        (SELECT COUNT(*)::int FROM findings_events WHERE occurred_at >= ${eventsCutoff.toISOString()}) AS events_24h;
    `);

    const severityDist = await deps.db.db.execute(sql`
      WITH latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id
        FROM scan_runs
        WHERE expansion_status = 'done'
        ORDER BY machine_id, collected_at DESC
      )
      SELECT em.severity, COUNT(*)::int AS c
      FROM effective_members em
      JOIN latest_scan ls ON ls.id = em.scan_run_id
      GROUP BY em.severity;
    `);

    // Top 10 — mesmos filtros da aba "Por usuário" em /findings:
    //   source = X, sem exception, sem service account, habilitado, direto.
    // Sem esses filtros o top vira lista de contas de admin/service com
    // ~800 máquinas (ruído). Com eles aparece quem realmente vale auditar.
    const topAdUsers = await deps.db.db.execute(sql`
      WITH latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id
        FROM scan_runs
        WHERE expansion_status = 'done'
        ORDER BY machine_id, collected_at DESC
      )
      SELECT em.sid,
             COALESCE(au.display_name, em.name, em.sid) AS name,
             au.sam_account_name,
             au.email,
             au.department,
             COUNT(DISTINCT em.machine_id)::int AS machine_count
      FROM effective_members em
      JOIN latest_scan ls ON ls.id = em.scan_run_id
      LEFT JOIN ad_users au ON au.sid = em.sid
      WHERE em.source = 'AD_USER'
        AND em.matched_exception_id IS NULL
        AND COALESCE(em.is_service_account, false) = false
        AND COALESCE(em.ad_enabled, true) = true
        AND em.via_group IS NULL
      GROUP BY em.sid, au.display_name, em.name, au.sam_account_name, au.email, au.department
      ORDER BY machine_count DESC, name ASC
      LIMIT 10;
    `);

    const topLocalUsers = await deps.db.db.execute(sql`
      WITH latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id
        FROM scan_runs
        WHERE expansion_status = 'done'
        ORDER BY machine_id, collected_at DESC
      )
      SELECT em.sid,
             COALESCE(em.name, em.sid) AS name,
             COUNT(DISTINCT em.machine_id)::int AS machine_count
      FROM effective_members em
      JOIN latest_scan ls ON ls.id = em.scan_run_id
      WHERE em.source = 'LOCAL_USER'
        AND em.matched_exception_id IS NULL
        AND COALESCE(em.is_service_account, false) = false
        AND COALESCE(em.ad_enabled, true) = true
        AND em.via_group IS NULL
      GROUP BY em.sid, em.name
      ORDER BY machine_count DESC, name ASC
      LIMIT 10;
    `);

    const recentEvents = await deps.db.db.execute(sql`
      SELECT fe.id,
             fe.machine_id,
             m.dns_host_name AS host_name,
             fe.occurred_at,
             fe.kind,
             fe.sid,
             fe.name,
             fe.details
      FROM findings_events fe
      JOIN machines m ON m.id = fe.machine_id
      WHERE fe.occurred_at >= ${new Date(Date.now() - 7 * 86400_000).toISOString()}
      ORDER BY fe.occurred_at DESC
      LIMIT 30;
    `);

    reply.send({
      cards: dash.rows[0] ?? {},
      severityDistribution: severityDist.rows,
      topAdUsers: topAdUsers.rows,
      topLocalUsers: topLocalUsers.rows,
      recentEvents: recentEvents.rows,
    });
  });
}
