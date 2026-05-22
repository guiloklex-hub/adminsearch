import { and, eq, or, sql } from 'drizzle-orm';
import type { DbClient } from '@server/db/client.ts';
import { findingsEvents, machines } from '@server/db/schema.ts';
import type { MachineContext } from '@shared/ingest-contract.ts';

export interface IdentifiedMachine {
  id: string;
  created: boolean;
  renamed: boolean;
  previousHostName: string | null;
}

/**
 * Reconciliação:
 *  1. Procura por dns_host_name exato.
 *  2. Se não achou, tenta bios_serial / chassis_uuid (estáveis em rename).
 *     Se achou e o hostname mudou, registra MACHINE_RENAMED.
 *  3. Senão, cria nova máquina.
 *
 * Sempre atualiza os campos voláteis (osVersion, ipAddresses, last_seen_at, etc).
 */
export async function identifyMachine(
  deps: { db: DbClient },
  ctx: MachineContext,
  collectedAt: Date,
  agentVersion: string,
): Promise<IdentifiedMachine> {
  const { db } = deps;

  // 1. FQDN exato
  let row = await db.db.query.machines.findFirst({
    where: eq(machines.dnsHostName, ctx.dnsHostName),
  });

  let renamed = false;
  let previousHostName: string | null = null;

  // 2. Fallback por bios_serial / chassis_uuid
  if (!row && (ctx.biosSerial || ctx.chassisUuid)) {
    row = await db.db.query.machines.findFirst({
      where: or(
        ctx.biosSerial ? eq(machines.biosSerial, ctx.biosSerial) : sql`false`,
        ctx.chassisUuid ? eq(machines.chassisUuid, ctx.chassisUuid) : sql`false`,
      ),
    });
    if (row && row.dnsHostName !== ctx.dnsHostName) {
      renamed = true;
      previousHostName = row.dnsHostName;
    }
  }

  if (row) {
    await db.db
      .update(machines)
      .set({
        dnsHostName: ctx.dnsHostName,
        netBiosName: ctx.netBiosName,
        domain: ctx.domain,
        biosSerial: ctx.biosSerial ?? row.biosSerial,
        chassisUuid: ctx.chassisUuid ?? row.chassisUuid,
        primaryMac: ctx.primaryMac ?? row.primaryMac,
        osCaption: ctx.osCaption ?? row.osCaption,
        osVersion: ctx.osVersion ?? row.osVersion,
        osBuild: ctx.osBuild ?? row.osBuild,
        lastBootAt: ctx.lastBootAt ? new Date(ctx.lastBootAt) : row.lastBootAt,
        lastLoggedUser: ctx.lastLoggedUser ?? row.lastLoggedUser,
        ipAddresses: ctx.ipAddresses.length > 0 ? ctx.ipAddresses : row.ipAddresses,
        agentVersion,
        lastSeenAt: collectedAt,
      })
      .where(eq(machines.id, row.id));

    if (renamed) {
      await db.db.insert(findingsEvents).values({
        machineId: row.id,
        occurredAt: collectedAt,
        kind: 'MACHINE_RENAMED',
        name: ctx.dnsHostName,
        details: { from: previousHostName, to: ctx.dnsHostName },
      });
    }

    return { id: row.id, created: false, renamed, previousHostName };
  }

  // 3. Cria nova máquina
  const [inserted] = await db.db
    .insert(machines)
    .values({
      dnsHostName: ctx.dnsHostName,
      netBiosName: ctx.netBiosName,
      domain: ctx.domain,
      biosSerial: ctx.biosSerial,
      chassisUuid: ctx.chassisUuid,
      primaryMac: ctx.primaryMac,
      osCaption: ctx.osCaption,
      osVersion: ctx.osVersion,
      osBuild: ctx.osBuild,
      lastBootAt: ctx.lastBootAt ? new Date(ctx.lastBootAt) : null,
      lastLoggedUser: ctx.lastLoggedUser,
      ipAddresses: ctx.ipAddresses,
      agentVersion,
      firstSeenAt: collectedAt,
      lastSeenAt: collectedAt,
    })
    .returning({ id: machines.id });

  if (!inserted) {
    throw new Error('Falha ao criar machine');
  }

  return { id: inserted.id, created: true, renamed: false, previousHostName: null };
}

/** Pequeno helper para silenciar TS no `and(...)`. */
export const _keep = and;
