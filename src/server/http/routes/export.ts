import type { DbClient } from '@server/db/client.ts';
import { adUsers, effectiveMembers, machines, scanRuns } from '@server/db/schema.ts';
import { csvRow } from '@server/utils/csv.ts';
import archiver from 'archiver';
import { and, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const BOM = '﻿';

const csvBool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => (typeof v === 'string' ? v === 'true' : (v ?? false)));

const csvList = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  );

const ByMachineQuery = z.object({
  q: z.string().trim().max(120).optional(),
  severity: csvList,
  source: csvList,
  hideExceptions: csvBool,
  onlyOrphans: csvBool,
});

const ByUserQuery = z.object({
  q: z.string().trim().max(120).optional(),
  source: csvList,
  hideExceptions: csvBool,
  hideServiceAccounts: csvBool,
  onlyEnabled: csvBool,
  onlyDirect: csvBool,
});

export async function registerExportRoutes(
  app: FastifyInstance,
  deps: { db: DbClient },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  // ---------------- Visão "Por máquina" — 1 linha por achado/máquina ----------------
  app.get('/api/v1/export/findings.csv', async (req, reply) => {
    const q = ByMachineQuery.parse(req.query);

    const filters = [];
    if (q.severity && q.severity.length > 0) {
      filters.push(inArray(effectiveMembers.severity, q.severity));
    }
    if (q.source && q.source.length > 0) {
      filters.push(inArray(effectiveMembers.source, q.source));
    }
    if (q.hideExceptions) filters.push(isNull(effectiveMembers.matchedExceptionId));
    if (q.onlyOrphans) filters.push(eq(effectiveMembers.source, 'ORPHAN_SID'));
    if (q.q) {
      filters.push(
        or(
          ilike(effectiveMembers.name, `%${q.q}%`),
          ilike(effectiveMembers.sid, `%${q.q}%`),
          ilike(effectiveMembers.viaGroup, `%${q.q}%`),
          ilike(machines.dnsHostName, `%${q.q}%`),
        ),
      );
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
      .header(
        'Content-Disposition',
        `attachment; filename="adminsearch-findings-by-machine-${todayStr()}.csv"`,
      );

    let out = BOM;
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

    return reply.send(out);
  });

  // ---------------- Visão "Por usuário" — ZIP com 2 CSVs ----------------
  // usuarios.csv          → 1 linha por SID (mesma agregação da tabela)
  // usuarios-maquinas.csv → expansão (1 linha por par usuário×máquina)
  app.get('/api/v1/export/findings-by-user.zip', async (req, reply) => {
    const q = ByUserQuery.parse(req.query);

    // Builder de WHERE — espelha /api/v1/findings/by-user
    const conditions: string[] = ['em.source IS NOT NULL'];
    if (q.source && q.source.length > 0) {
      const safeSources = q.source
        .filter((s) => /^[A-Z_]+$/.test(s))
        .map((s) => `'${s}'`)
        .join(',');
      if (safeSources) conditions.push(`em.source IN (${safeSources})`);
    }
    if (q.hideExceptions) conditions.push('em.matched_exception_id IS NULL');
    if (q.hideServiceAccounts) conditions.push('COALESCE(em.is_service_account, false) = false');
    if (q.onlyEnabled) conditions.push('COALESCE(em.ad_enabled, true) = true');
    if (q.q) {
      const safe = q.q.replace(/'/g, "''");
      conditions.push(
        `(COALESCE(au.display_name,'') ILIKE '%${safe}%' OR COALESCE(au.sam_account_name,'') ILIKE '%${safe}%' OR COALESCE(au.email,'') ILIKE '%${safe}%' OR COALESCE(au.department,'') ILIKE '%${safe}%' OR em.sid ILIKE '%${safe}%')`,
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const havingClause = q.onlyDirect
      ? 'HAVING COUNT(DISTINCT CASE WHEN em.via_group IS NULL THEN em.machine_id END) > 0'
      : '';

    // (a) Agregado por usuário
    const aggregatedResult = await deps.db.db.execute(sql`
      WITH latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id
        FROM scan_runs
        WHERE expansion_status = 'done'
        ORDER BY machine_id, collected_at DESC
      )
      SELECT em.sid,
             COALESCE(au.display_name, em.name, em.sid) AS name,
             au.sam_account_name,
             au.user_principal_name,
             au.email,
             au.department,
             au.title,
             au.enabled AS ad_enabled,
             au.is_service_account,
             au.last_logon,
             em.source,
             BOOL_OR(em.matched_exception_id IS NOT NULL) AS has_exception,
             COUNT(DISTINCT em.machine_id)::int AS machine_count,
             SUM(CASE WHEN em.severity='critical' THEN 1 ELSE 0 END)::int AS critical_count,
             SUM(CASE WHEN em.severity='high' THEN 1 ELSE 0 END)::int AS high_count,
             SUM(CASE WHEN em.severity='medium' THEN 1 ELSE 0 END)::int AS medium_count,
             SUM(CASE WHEN em.via_group IS NOT NULL THEN 1 ELSE 0 END)::int AS via_group_count,
             COUNT(DISTINCT CASE WHEN em.via_group IS NULL THEN em.machine_id END)::int AS direct_machine_count
      FROM effective_members em
      JOIN latest_scan ls ON ls.id = em.scan_run_id
      LEFT JOIN ad_users au ON au.sid = em.sid
      ${sql.raw(whereClause)}
      GROUP BY em.sid, au.display_name, em.name, au.sam_account_name, au.user_principal_name,
               au.email, au.department, au.title, au.enabled, au.is_service_account, au.last_logon,
               em.source
      ${sql.raw(havingClause)}
      ORDER BY machine_count DESC, name ASC;
    `);
    const aggregated = aggregatedResult.rows as unknown as AggregatedRow[];

    // (b) Expandido — só os SIDs que entraram no agregado, com 1 linha por máquina
    const sids = aggregated.map((r) => r.sid).filter((s): s is string => Boolean(s));
    let expanded: ExpandedRow[] = [];
    if (sids.length > 0) {
      const expandedResult = await deps.db.db.execute(sql`
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
               m.dns_host_name AS host_name,
               m.domain,
               m.last_logged_user,
               m.last_seen_at,
               em.via_group,
               em.severity,
               (em.matched_exception_id IS NOT NULL) AS has_exception
        FROM effective_members em
        JOIN latest_scan ls ON ls.id = em.scan_run_id
        JOIN machines m ON m.id = em.machine_id
        LEFT JOIN ad_users au ON au.sid = em.sid
        WHERE em.sid IN (${sql.raw(sids.map((s) => `'${s.replace(/'/g, "''")}'`).join(','))})
        ORDER BY name ASC, m.dns_host_name ASC;
      `);
      expanded = expandedResult.rows as unknown as ExpandedRow[];
    }

    // Monta CSVs em memória (são pequenos: agregado tem milhares de linhas, expandido dezenas de milhares)
    let csvAggregated = BOM;
    csvAggregated += csvRow([
      'sid',
      'nome',
      'sam_account_name',
      'user_principal_name',
      'email',
      'departamento',
      'cargo',
      'ad_habilitado',
      'service_account',
      'ultimo_logon',
      'tem_excecao',
      'origem',
      'maquinas_total',
      'direto',
      'via_grupo',
      'criticos',
      'altos',
      'medios',
    ]);
    for (const r of aggregated) {
      csvAggregated += csvRow([
        r.sid,
        r.name,
        r.sam_account_name,
        r.user_principal_name,
        r.email,
        r.department,
        r.title,
        boolStr(r.ad_enabled),
        r.is_service_account ? 'sim' : 'não',
        r.last_logon ? new Date(r.last_logon).toISOString() : '',
        r.has_exception ? 'sim' : 'não',
        r.source,
        r.machine_count,
        r.direct_machine_count,
        r.via_group_count,
        r.critical_count,
        r.high_count,
        r.medium_count,
      ]);
    }

    let csvExpanded = BOM;
    csvExpanded += csvRow([
      'sid',
      'nome',
      'sam_account_name',
      'email',
      'departamento',
      'host_maquina',
      'dominio',
      'ultimo_user_logado',
      'ultimo_scan',
      'via_grupo',
      'severidade',
      'tem_excecao',
    ]);
    for (const r of expanded) {
      csvExpanded += csvRow([
        r.sid,
        r.name,
        r.sam_account_name,
        r.email,
        r.department,
        r.host_name,
        r.domain,
        r.last_logged_user,
        r.last_seen_at ? new Date(r.last_seen_at).toISOString() : '',
        r.via_group,
        r.severity,
        r.has_exception ? 'sim' : 'não',
      ]);
    }

    reply
      .header('Content-Type', 'application/zip')
      .header(
        'Content-Disposition',
        `attachment; filename="adminsearch-findings-by-user-${todayStr()}.zip"`,
      );

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.append(Buffer.from(csvAggregated, 'utf8'), { name: 'usuarios.csv' });
    archive.append(Buffer.from(csvExpanded, 'utf8'), { name: 'usuarios-maquinas.csv' });
    archive.finalize();

    return reply.send(archive);
  });

  // ---------------- Visão "Por grupo herdado" ----------------
  app.get('/api/v1/export/findings-by-group.csv', async (_req, reply) => {
    const rowsResult = await deps.db.db.execute(sql`
      WITH latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id
        FROM scan_runs
        WHERE expansion_status = 'done'
        ORDER BY machine_id, collected_at DESC
      )
      SELECT em.via_group AS group_name,
             em.via_group_sid AS group_sid,
             COUNT(DISTINCT em.sid)::int AS user_count,
             COUNT(DISTINCT em.machine_id)::int AS machine_count
      FROM effective_members em
      JOIN latest_scan ls ON ls.id = em.scan_run_id
      WHERE em.via_group IS NOT NULL
      GROUP BY em.via_group, em.via_group_sid
      ORDER BY machine_count DESC;
    `);
    const rows = rowsResult.rows as unknown as GroupRow[];

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="adminsearch-findings-by-group-${todayStr()}.csv"`,
      );

    let out = BOM;
    out += csvRow(['grupo_nome', 'grupo_sid', 'usuarios_unicos', 'maquinas_alcancadas']);
    for (const r of rows) {
      out += csvRow([r.group_name, r.group_sid, r.user_count, r.machine_count]);
    }

    return reply.send(out);
  });
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function boolStr(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  return v ? 'sim' : 'não';
}

interface AggregatedRow {
  sid: string | null;
  name: string | null;
  sam_account_name: string | null;
  user_principal_name: string | null;
  email: string | null;
  department: string | null;
  title: string | null;
  ad_enabled: boolean | null;
  is_service_account: boolean | null;
  last_logon: string | Date | null;
  has_exception: boolean | null;
  source: string | null;
  machine_count: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  via_group_count: number;
  direct_machine_count: number;
}

interface ExpandedRow {
  sid: string | null;
  name: string | null;
  sam_account_name: string | null;
  email: string | null;
  department: string | null;
  host_name: string | null;
  domain: string | null;
  last_logged_user: string | null;
  last_seen_at: string | Date | null;
  via_group: string | null;
  severity: string | null;
  has_exception: boolean | null;
}

interface GroupRow {
  group_name: string | null;
  group_sid: string | null;
  user_count: number;
  machine_count: number;
}
