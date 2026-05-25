/**
 * backfill-reason-codes.ts
 *
 * Preenche `effective_members.reason_code` para linhas pré-existentes
 * (criadas antes da migration 0002). Computa o reasonCode a partir dos
 * sinais já persistidos — sem precisar recarregar `CachedAdUser`.
 *
 * Idempotente: só toca linhas com `reason_code IS NULL`. Pode rodar várias
 * vezes sem efeito colateral.
 *
 * Uso:
 *   npm run backfill:reason-codes
 *   DATABASE_URL=... npm run backfill:reason-codes
 */
import { createDb } from '@server/db/client.ts';
import { effectiveMembers } from '@server/db/schema.ts';
import { type MemberSource, classifySeverityFromRow } from '@server/enricher/severity.ts';
import { and, eq, isNull, sql } from 'drizzle-orm';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL não definido');
  }

  const db = createDb({ url });

  const total = await db.db
    .select({ c: sql<number>`count(*)::int` })
    .from(effectiveMembers)
    .where(isNull(effectiveMembers.reasonCode));
  const totalCount = total[0]?.c ?? 0;
  // biome-ignore lint/suspicious/noConsole: script standalone
  console.log(`Linhas pendentes: ${totalCount}`);

  if (totalCount === 0) {
    await db.pool.end();
    return;
  }

  const BATCH = 1000;
  let processed = 0;
  let updated = 0;

  while (processed < totalCount) {
    const rows = await db.db
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
      .where(isNull(effectiveMembers.reasonCode))
      .limit(BATCH);

    if (rows.length === 0) break;

    // Aplicar 1 por 1 (poderia agrupar por reasonCode, mas o ganho é pequeno
    // e a clareza vale mais — são ~10k linhas no pior caso da empresa).
    for (const row of rows) {
      const { reasonCode } = classifySeverityFromRow({
        sid: row.sid,
        source: row.source as MemberSource,
        viaGroup: row.viaGroup,
        viaGroupSid: row.viaGroupSid,
        adEnabled: row.adEnabled,
        isServiceAccount: row.isServiceAccount,
        hasMatchedException: row.matchedExceptionId !== null,
      });

      const res = await db.db
        .update(effectiveMembers)
        .set({ reasonCode })
        .where(and(eq(effectiveMembers.id, row.id), isNull(effectiveMembers.reasonCode)))
        .returning({ id: effectiveMembers.id });
      if (res.length > 0) updated += 1;
    }

    processed += rows.length;
    // biome-ignore lint/suspicious/noConsole: script standalone
    console.log(`Progresso: ${processed}/${totalCount}`);
  }

  // biome-ignore lint/suspicious/noConsole: script standalone
  console.log(`Concluído. ${updated} linha(s) atualizada(s).`);

  await db.pool.end();
}

void main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: script standalone
  console.error('Falha no backfill:', err);
  process.exit(1);
});
