import type { DbClient } from '@server/db/client.ts';
import { auditLog, effectiveMembers, institutionalGroups } from '@server/db/schema.ts';
import { getInstitutionalGroupsCache } from '@server/enricher/institutional-groups-cache.ts';
import { getSeverityPolicyCache } from '@server/enricher/severity-policy-cache.ts';
import {
  DEFAULT_SEVERITY_BY_REASON,
  type MemberSource,
  classifySeverityFromRow,
} from '@server/enricher/severity.ts';
import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const SidParam = z.object({
  sid: z
    .string()
    .min(1)
    .max(184)
    .regex(/^S-\d+-\d+(-\d+)*$/i, 'SID inválido'),
});

const UpsertBody = z.object({
  displayName: z.string().trim().min(1).max(255),
  samAccountName: z.string().trim().max(255).nullable().optional(),
});

export async function registerInstitutionalGroupsRoutes(
  app: FastifyInstance,
  deps: { db: DbClient },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  /**
   * GET /api/v1/institutional-groups
   * Lista todos os grupos cadastrados + contagem de `effective_members`
   * atualmente afetados (linhas com aquele SID).
   */
  app.get('/api/v1/institutional-groups', async (_req, reply) => {
    const groups = await deps.db.db
      .select()
      .from(institutionalGroups)
      .orderBy(desc(institutionalGroups.updatedAt));

    if (groups.length === 0) {
      reply.send({ items: [] });
      return;
    }

    const counts = await deps.db.db
      .select({
        sid: effectiveMembers.sid,
        count: sql<number>`count(*)::int`,
      })
      .from(effectiveMembers)
      .groupBy(effectiveMembers.sid);
    const countBySid = new Map<string, number>();
    for (const c of counts) countBySid.set(c.sid, c.count);

    reply.send({
      items: groups.map((g) => ({
        sid: g.sid,
        displayName: g.displayName,
        samAccountName: g.samAccountName,
        createdBy: g.createdBy,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        affectedCount: countBySid.get(g.sid) ?? 0,
      })),
    });
  });

  /**
   * PUT /api/v1/institutional-groups/:sid
   * Upsert do registro + reclassificação retroativa em massa de
   * `effective_members` com esse `sid`:
   *   - name = displayName
   *   - source = WELL_KNOWN
   *   - reasonCode = INSTITUTIONAL_GROUP_DIRECT
   *   - severity = resolveSeverity(reasonCode, default low)
   */
  app.put('/api/v1/institutional-groups/:sid', async (req, reply) => {
    const { sid } = SidParam.parse(req.params);
    const body = UpsertBody.parse(req.body);
    const username = req.user.username;

    const policyCache = getSeverityPolicyCache();
    await policyCache.ensureLoaded();
    const effectiveSeverity = policyCache.resolve('INSTITUTIONAL_GROUP_DIRECT');

    let affectedRows = 0;
    await deps.db.db.transaction(async (tx) => {
      await tx
        .insert(institutionalGroups)
        .values({
          sid,
          displayName: body.displayName,
          samAccountName: body.samAccountName ?? null,
          createdBy: username,
        })
        .onConflictDoUpdate({
          target: institutionalGroups.sid,
          set: {
            displayName: body.displayName,
            samAccountName: body.samAccountName ?? null,
            updatedAt: new Date(),
          },
        });

      const updateResult = await tx
        .update(effectiveMembers)
        .set({
          name: body.displayName,
          source: 'WELL_KNOWN',
          reasonCode: 'INSTITUTIONAL_GROUP_DIRECT',
          severity: effectiveSeverity,
        })
        .where(eq(effectiveMembers.sid, sid))
        .returning({ id: effectiveMembers.id });
      affectedRows = updateResult.length;
    });

    getInstitutionalGroupsCache().invalidate();
    await getInstitutionalGroupsCache().ensureLoaded();

    await deps.db.db.insert(auditLog).values({
      actor: username,
      action: 'institutional_group_set',
      details: {
        sid,
        displayName: body.displayName,
        samAccountName: body.samAccountName ?? null,
        affectedRows,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });

    reply.send({
      ok: true,
      sid,
      displayName: body.displayName,
      affectedRows,
      severity: effectiveSeverity,
    });
  });

  /**
   * DELETE /api/v1/institutional-groups/:sid
   * Remove cadastro + recompõe `effective_members` para todas as linhas
   * com aquele SID. Como classifySeverityFromRow é puro, podemos
   * iterar (são poucas linhas — só as com sid=X).
   */
  app.delete('/api/v1/institutional-groups/:sid', async (req, reply) => {
    const { sid } = SidParam.parse(req.params);
    const username = req.user.username;

    const policyCache = getSeverityPolicyCache();
    await policyCache.ensureLoaded();

    let affectedRows = 0;
    await deps.db.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(institutionalGroups)
        .where(eq(institutionalGroups.sid, sid))
        .returning({ sid: institutionalGroups.sid });
      if (deleted.length === 0) return;

      // Para cada linha de effective_members com esse SID, recomputar
      // reasonCode/severity *sem* o cadastro institucional (já removido).
      const rows = await tx
        .select({
          id: effectiveMembers.id,
          sid: effectiveMembers.sid,
          source: effectiveMembers.source,
          viaGroup: effectiveMembers.viaGroup,
          viaGroupSid: effectiveMembers.viaGroupSid,
          adEnabled: effectiveMembers.adEnabled,
          isServiceAccount: effectiveMembers.isServiceAccount,
          matchedExceptionId: effectiveMembers.matchedExceptionId,
        })
        .from(effectiveMembers)
        .where(eq(effectiveMembers.sid, sid));

      for (const r of rows) {
        const { severity: defaultSeverity, reasonCode } = classifySeverityFromRow({
          sid: r.sid,
          source: r.source as MemberSource,
          viaGroup: r.viaGroup,
          viaGroupSid: r.viaGroupSid,
          adEnabled: r.adEnabled,
          isServiceAccount: r.isServiceAccount,
          hasMatchedException: r.matchedExceptionId !== null,
        });
        const effectiveSeverity = policyCache.resolve(reasonCode) ?? defaultSeverity;
        await tx
          .update(effectiveMembers)
          .set({ reasonCode, severity: effectiveSeverity })
          .where(eq(effectiveMembers.id, r.id));
      }
      affectedRows = rows.length;
    });

    getInstitutionalGroupsCache().invalidate();
    await getInstitutionalGroupsCache().ensureLoaded();

    await deps.db.db.insert(auditLog).values({
      actor: username,
      action: 'institutional_group_unset',
      details: { sid, affectedRows },
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });

    reply.send({ ok: true, sid, affectedRows });
  });
}

// Manter import usado para evitar tree-shake em casos extremos.
export { DEFAULT_SEVERITY_BY_REASON };
