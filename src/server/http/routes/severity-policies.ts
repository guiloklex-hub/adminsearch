import type { DbClient } from '@server/db/client.ts';
import { auditLog, effectiveMembers, severityPolicies } from '@server/db/schema.ts';
import { getSeverityPolicyCache } from '@server/enricher/severity-policy-cache.ts';
import {
  DEFAULT_SEVERITY_BY_REASON,
  REASON_CODES,
  REASON_LABELS,
  type ReasonCode,
  type Severity,
} from '@server/enricher/severity.ts';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const SEVERITY_VALUES = ['critical', 'high', 'medium', 'low', 'info'] as const;

const ReasonCodeParam = z.object({
  reasonCode: z.enum(REASON_CODES),
});

const SeverityBody = z.object({
  severity: z.enum(SEVERITY_VALUES),
});

export async function registerSeverityPoliciesRoutes(
  app: FastifyInstance,
  deps: { db: DbClient },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  /**
   * GET /api/v1/severity-policies
   * Retorna a tabela completa de motivos: cada linha traz o nível default
   * do sistema, o override atual (se houver) e quantos `effective_members`
   * estão classificados com aquele motivo no banco hoje.
   */
  app.get('/api/v1/severity-policies', async (_req, reply) => {
    const overrides = await deps.db.db.select().from(severityPolicies);
    const overrideMap = new Map<string, { severity: string; updatedAt: Date; updatedBy: string }>();
    for (const o of overrides) {
      overrideMap.set(o.reasonCode, {
        severity: o.severityOverride,
        updatedAt: o.updatedAt,
        updatedBy: o.updatedBy,
      });
    }

    // Conta admins por reason_code (uma única query agregada).
    const counts = await deps.db.db
      .select({
        reasonCode: effectiveMembers.reasonCode,
        count: sql<number>`count(*)::int`,
      })
      .from(effectiveMembers)
      .groupBy(effectiveMembers.reasonCode);
    const countMap = new Map<string, number>();
    for (const c of counts) {
      if (c.reasonCode) countMap.set(c.reasonCode, c.count);
    }

    const items = REASON_CODES.map((code) => {
      const labels = REASON_LABELS[code];
      const ov = overrideMap.get(code);
      return {
        reasonCode: code,
        title: labels.title,
        description: labels.description,
        defaultSeverity: DEFAULT_SEVERITY_BY_REASON[code],
        effectiveSeverity: ov?.severity ?? DEFAULT_SEVERITY_BY_REASON[code],
        overridden: !!ov,
        override: ov
          ? {
              severity: ov.severity,
              updatedAt: ov.updatedAt,
              updatedBy: ov.updatedBy,
            }
          : null,
        affectedCount: countMap.get(code) ?? 0,
      };
    });

    reply.send({ items });
  });

  /**
   * PUT /api/v1/severity-policies/:reasonCode
   * Upsert do override. Em uma única transação:
   *  - grava na tabela `severity_policies`;
   *  - atualiza `effective_members.severity` em massa para refletir imediato.
   * Após commit, invalida o cache em memória e grava audit_log.
   */
  app.put('/api/v1/severity-policies/:reasonCode', async (req, reply) => {
    const { reasonCode } = ReasonCodeParam.parse(req.params);
    const { severity } = SeverityBody.parse(req.body);

    const previousOverride = (
      await deps.db.db
        .select()
        .from(severityPolicies)
        .where(eq(severityPolicies.reasonCode, reasonCode))
    )[0];

    let affectedRows = 0;
    await deps.db.db.transaction(async (tx) => {
      await tx
        .insert(severityPolicies)
        .values({
          reasonCode,
          severityOverride: severity,
          updatedBy: req.user.username,
        })
        .onConflictDoUpdate({
          target: severityPolicies.reasonCode,
          set: {
            severityOverride: severity,
            updatedAt: new Date(),
            updatedBy: req.user.username,
          },
        });

      const updateResult = await tx
        .update(effectiveMembers)
        .set({ severity })
        .where(eq(effectiveMembers.reasonCode, reasonCode))
        .returning({ id: effectiveMembers.id });
      affectedRows = updateResult.length;
    });

    getSeverityPolicyCache().invalidate();
    await getSeverityPolicyCache().ensureLoaded();

    await deps.db.db.insert(auditLog).values({
      actor: req.user.username,
      action: 'severity_policy_set',
      details: {
        reasonCode,
        severity,
        previousSeverity:
          previousOverride?.severityOverride ??
          DEFAULT_SEVERITY_BY_REASON[reasonCode as ReasonCode],
        affectedRows,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });

    reply.send({
      ok: true,
      reasonCode,
      severity,
      affectedRows,
    });
  });

  /**
   * DELETE /api/v1/severity-policies/:reasonCode
   * Remove override + restaura severity default em massa em `effective_members`.
   */
  app.delete('/api/v1/severity-policies/:reasonCode', async (req, reply) => {
    const { reasonCode } = ReasonCodeParam.parse(req.params);
    const defaultSeverity: Severity = DEFAULT_SEVERITY_BY_REASON[reasonCode as ReasonCode];

    let affectedRows = 0;
    await deps.db.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(severityPolicies)
        .where(eq(severityPolicies.reasonCode, reasonCode))
        .returning({ reasonCode: severityPolicies.reasonCode });
      if (deleted.length === 0) {
        // Não havia override — nada a fazer.
        return;
      }
      const updateResult = await tx
        .update(effectiveMembers)
        .set({ severity: defaultSeverity })
        .where(eq(effectiveMembers.reasonCode, reasonCode))
        .returning({ id: effectiveMembers.id });
      affectedRows = updateResult.length;
    });

    getSeverityPolicyCache().invalidate();
    await getSeverityPolicyCache().ensureLoaded();

    await deps.db.db.insert(auditLog).values({
      actor: req.user.username,
      action: 'severity_policy_unset',
      details: {
        reasonCode,
        restoredTo: defaultSeverity,
        affectedRows,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });

    reply.send({ ok: true, reasonCode, restoredTo: defaultSeverity, affectedRows });
  });
}
