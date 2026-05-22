import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DbClient } from '@server/db/client.ts';
import { adUsers, effectiveMembers, machines, scanRuns } from '@server/db/schema.ts';
import { csvRow } from '@server/utils/csv.ts';

const ExportQuery = z.object({
  severity: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined)),
  source: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined)),
  hideExceptions: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v === 'true' : v ?? false)),
});

export async function registerExportRoutes(
  app: FastifyInstance,
  deps: { db: DbClient },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  app.get('/api/v1/export/findings.csv', async (req, reply) => {
    const q = ExportQuery.parse(req.query);

    const filters = [];
    if (q.severity && q.severity.length > 0) {
      filters.push(inArray(effectiveMembers.severity, q.severity));
    }
    if (q.source && q.source.length > 0) {
      filters.push(inArray(effectiveMembers.source, q.source));
    }
    if (q.hideExceptions) {
      filters.push(isNull(effectiveMembers.matchedExceptionId));
    }

    const rows = await deps.db.db
      .select({
        hostName: machines.dnsHostName,
        domain: machines.domain,
        osCaption: machines.osCaption,
        lastSeenAt: machines.lastSeenAt,
        tags: machines.tags,
        sid: effectiveMembers.sid,
        name: effectiveMembers.name,
        samAccountName: adUsers.samAccountName,
        displayName: adUsers.displayName,
        department: adUsers.department,
        email: adUsers.email,
        enabled: effectiveMembers.adEnabled,
        source: effectiveMembers.source,
        viaGroup: effectiveMembers.viaGroup,
        severity: effectiveMembers.severity,
        scanCollectedAt: scanRuns.collectedAt,
      })
      .from(effectiveMembers)
      .innerJoin(
        scanRuns,
        and(
          eq(scanRuns.id, effectiveMembers.scanRunId),
          sql`scan_runs.id = (
            SELECT id FROM scan_runs s2
            WHERE s2.machine_id = scan_runs.machine_id
              AND s2.expansion_status = 'done'
            ORDER BY s2.collected_at DESC
            LIMIT 1
          )`,
        ),
      )
      .innerJoin(machines, eq(machines.id, effectiveMembers.machineId))
      .leftJoin(adUsers, eq(adUsers.sid, effectiveMembers.sid))
      .where(filters.length ? and(...filters) : undefined);

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="adminsearch-findings-${todayStr()}.csv"`);

    // Streaming manual (resposta simples — payload é alguns MB no pior caso)
    let out = '﻿'; // BOM para Excel abrir UTF-8 direito
    out += csvRow([
      'host',
      'domain',
      'so',
      'ultimo_scan',
      'tags',
      'sid',
      'usuario',
      'sam',
      'nome_ad',
      'departamento',
      'email',
      'habilitada_ad',
      'origem',
      'via_grupo',
      'severidade',
      'visto_em',
    ]);

    for (const r of rows) {
      out += csvRow([
        r.hostName,
        r.domain,
        r.osCaption,
        r.lastSeenAt?.toISOString(),
        (r.tags ?? []).join('|'),
        r.sid,
        r.name,
        r.samAccountName,
        r.displayName,
        r.department,
        r.email,
        r.enabled === null ? '' : r.enabled ? 'sim' : 'não',
        r.source,
        r.viaGroup,
        r.severity,
        r.scanCollectedAt?.toISOString(),
      ]);
    }

    reply.send(out);
  });
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
