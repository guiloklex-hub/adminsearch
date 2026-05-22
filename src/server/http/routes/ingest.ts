import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@server/db/client.ts';
import { rawMembers, scanRuns } from '@server/db/schema.ts';
import { identifyMachine } from '@server/ingest/identify-machine.ts';
import { timingSafeEquals } from '@server/utils/timing-safe.ts';
import { IngestPayloadSchema } from '@shared/ingest-contract.ts';

export async function registerIngestRoute(
  app: FastifyInstance,
  deps: { db: DbClient; ingestToken: string },
): Promise<void> {
  app.post(
    '/api/v1/ingest',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      bodyLimit: 256 * 1024,
    },
    async (req, reply) => {
      // 1. Auth via Bearer
      const auth = req.headers.authorization ?? '';
      const m = /^Bearer\s+(.+)$/.exec(auth);
      if (!m || !timingSafeEquals(m[1] ?? '', deps.ingestToken)) {
        reply.status(401).send({ message: 'Não autorizado' });
        return;
      }

      // 2. Validação Zod
      const payload = IngestPayloadSchema.parse(req.body);

      // 3. Idempotência por scanId
      const existing = await deps.db.db.query.scanRuns.findFirst({
        where: eq(scanRuns.id, payload.scanId),
      });
      if (existing) {
        reply.status(200).send({
          duplicate: true,
          scanId: payload.scanId,
          machineId: existing.machineId,
        });
        return;
      }

      // 4. Reconcilia/cria máquina + insere scan_run + raw_members em transação
      const collectedAt = new Date(payload.collectedAt);

      const identified = await identifyMachine(
        { db: deps.db },
        payload.machine,
        collectedAt,
        payload.agentVersion,
      );

      await deps.db.db.transaction(async (tx) => {
        await tx.insert(scanRuns).values({
          id: payload.scanId,
          machineId: identified.id,
          collectedAt,
          source: payload.source,
          agentVersion: payload.agentVersion,
          totalRawMembers: payload.members.length,
          rawPayload: payload as unknown,
          expansionStatus: 'pending',
        });

        if (payload.members.length > 0) {
          await tx.insert(rawMembers).values(
            payload.members.map((m) => ({
              scanRunId: payload.scanId,
              sid: m.sid,
              name: m.name ?? null,
              objectClass: m.objectClass,
              resolved: m.resolved,
            })),
          );
        }
      });

      req.log.info(
        {
          scanId: payload.scanId,
          machineId: identified.id,
          host: payload.machine.dnsHostName,
          members: payload.members.length,
          created: identified.created,
          renamed: identified.renamed,
        },
        'scan recebido',
      );

      reply.status(202).send({
        scanId: payload.scanId,
        machineId: identified.id,
        created: identified.created,
        renamed: identified.renamed,
      });
    },
  );
}
