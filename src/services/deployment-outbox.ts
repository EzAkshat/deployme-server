import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../config/database.js';
import { deploymentQueue } from '../queues/deployment-queue.js';

const BATCH_SIZE = 20;
export const MAX_ATTEMPTS = 10;
export const CLAIM_LEASE_MS = 60_000;

type ClaimedOutboxEvent = {
  id: string;
  deploymentId: string;
  eventType: string;
  payload: Prisma.JsonValue;
  attempts: number;
  claimToken: string;
};

export async function dispatchDeploymentOutboxBatch(): Promise<number> {
  const claimToken = randomUUID();
  const staleBefore = new Date(Date.now() - CLAIM_LEASE_MS);

  const events = await prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<Omit<ClaimedOutboxEvent, 'claimToken'>[]>`
  SELECT "id", "deploymentId", "eventType", "payload", "attempts"
  FROM "DeploymentOutbox"
  WHERE "processedAt" IS NULL
    AND "eventType" = 'DEPLOYMENT_REQUESTED'
    AND "attempts" < ${MAX_ATTEMPTS}
    AND (
      "claimToken" IS NULL
      OR "claimedAt" < ${staleBefore}
    )
  ORDER BY "createdAt" ASC
  LIMIT ${BATCH_SIZE}
  FOR UPDATE SKIP LOCKED
`;

    if (claimed.length === 0) {
      return [];
    }

    const ids = claimed.map((event) => event.id);

    await tx.deploymentOutbox.updateMany({
      where: { id: { in: ids } },
      data: {
        claimToken,
        claimedAt: new Date(),
        attempts: { increment: 1 },
      },
    });

    return claimed.map((event) => ({
      ...event,
      claimToken,
      attempts: event.attempts + 1,
    }));
  });

  let dispatched = 0;

  for (const event of events) {
    try {
      const payload = event.payload;

      if (
        payload === null ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        typeof payload.deploymentId !== 'string' ||
        typeof payload.projectId !== 'string' ||
        typeof payload.commitSha !== 'string' ||
        !/^[a-f0-9]{40}$/i.test(payload.commitSha) ||
        payload.deploymentId !== event.deploymentId
      ) {
        throw new Error('Invalid deployment outbox payload');
      }

      await deploymentQueue.add(
        event.eventType,
        {
          deploymentId: payload.deploymentId,
          projectId: payload.projectId,
          commitSha: payload.commitSha,
          outboxEventId: event.id,
        },
        {
          jobId: `outbox-${event.id}`,
        },
      );

      const marked = await prisma.deploymentOutbox.updateMany({
        where: {
          id: event.id,
          claimToken: event.claimToken,
          processedAt: null,
        },
        data: {
          processedAt: new Date(),
          claimToken: null,
          claimedAt: null,
          lastError: null,
        },
      });

      if (marked.count === 1) {
        dispatched += 1;
      } else {
        console.warn('Outbox event claim was lost before marking processed.', {
          outboxEventId: event.id,
          deploymentId: event.deploymentId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown dispatch error';

      try {
        const released = await prisma.deploymentOutbox.updateMany({
          where: {
            id: event.id,
            claimToken: event.claimToken,
            processedAt: null,
          },
          data: {
            claimToken: null,
            claimedAt: null,
            lastError: message.slice(0, 2000),
          },
        });

        if (released.count === 1 && event.attempts >= MAX_ATTEMPTS) {
          console.error('Deployment outbox event exhausted its attempts.', {
            outboxEventId: event.id,
            deploymentId: event.deploymentId,
            attempts: event.attempts,
            error: message,
          });
        }
      } catch (recordError) {
        console.error('Failed to record deployment outbox error.', {
          outboxEventId: event.id,
          error: recordError instanceof Error ? recordError.message : 'Unknown database error',
        });
      }
    }
  }

  return dispatched;
}

export async function getExhaustedDeploymentOutboxEvents() {
  return prisma.deploymentOutbox.findMany({
    where: {
      processedAt: null,
      attempts: {
        gte: MAX_ATTEMPTS,
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
    take: 100,
    select: {
      id: true,
      deploymentId: true,
      eventType: true,
      attempts: true,
      lastError: true,
      createdAt: true,
    },
  });
}
