import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@server/db/client.ts';

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

    const topUsers = await deps.db.db.execute(sql`
      WITH latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id
        FROM scan_runs
        WHERE expansion_status = 'done'
        ORDER BY machine_id, collected_at DESC
      )
      SELECT em.sid,
             COALESCE(au.display_name, em.name, em.sid) AS name,
             au.sam_account_name,
             COUNT(DISTINCT em.machine_id)::int AS machine_count
      FROM effective_members em
      JOIN latest_scan ls ON ls.id = em.scan_run_id
      LEFT JOIN ad_users au ON au.sid = em.sid
      WHERE em.source IN ('AD_USER','ORPHAN_SID')
      GROUP BY em.sid, name, au.sam_account_name
      ORDER BY machine_count DESC
      LIMIT 10;
    `);

    reply.send({
      cards: dash.rows[0] ?? {},
      severityDistribution: severityDist.rows,
      topUsers: topUsers.rows,
    });
  });
}
