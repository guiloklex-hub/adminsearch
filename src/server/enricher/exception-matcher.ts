import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { DbClient } from '@server/db/client.ts';
import { exceptions, machines } from '@server/db/schema.ts';

export interface ExceptionMatchInput {
  machineId: string;
  sid: string;
  samAccountName: string | null;
  groupSid: string | null;
  groupCn: string | null;
}

/**
 * Procura uma exceção que cubra a combinação atual. Ordem:
 *  - escopo `machine` específico
 *  - escopo `tag` (qualquer tag presente na máquina)
 *  - escopo `global`
 *
 * Critério de match: `match_kind` + `match_value` baterem com SID, sAM ou
 * grupo herdado. Exceções expiradas são ignoradas.
 */
export async function findMatchingException(
  db: DbClient,
  input: ExceptionMatchInput,
): Promise<{ id: string } | null> {
  const now = new Date();

  // Pega tags da máquina (UMA query)
  const machine = await db.db.query.machines.findFirst({
    where: eq(machines.id, input.machineId),
    columns: { id: true, tags: true },
  });
  const tags = machine?.tags ?? [];

  const matchClauses = [
    and(eq(exceptions.matchKind, 'sid'), eq(exceptions.matchValue, input.sid)),
    input.samAccountName
      ? and(eq(exceptions.matchKind, 'sam'), eq(exceptions.matchValue, input.samAccountName))
      : sql`false`,
    input.groupSid
      ? and(eq(exceptions.matchKind, 'group'), eq(exceptions.matchValue, input.groupSid))
      : sql`false`,
    input.groupCn
      ? and(eq(exceptions.matchKind, 'group'), eq(exceptions.matchValue, input.groupCn))
      : sql`false`,
  ];

  const scopeClauses = [
    and(eq(exceptions.scope, 'machine'), eq(exceptions.scopeValue, input.machineId)),
    and(eq(exceptions.scope, 'global')),
    tags.length > 0
      ? and(
          eq(exceptions.scope, 'tag'),
          sql`${exceptions.scopeValue} = ANY(${sql.raw(`ARRAY[${tags
            .map((t) => `'${t.replace(/'/g, "''")}'`)
            .join(',')}]::text[]`)})`,
        )
      : sql`false`,
  ];

  const [match] = await db.db
    .select({ id: exceptions.id })
    .from(exceptions)
    .where(
      and(
        or(...matchClauses),
        or(...scopeClauses),
        or(isNull(exceptions.expiresAt), gt(exceptions.expiresAt, now)),
      ),
    )
    .limit(1);

  return match ?? null;
}
