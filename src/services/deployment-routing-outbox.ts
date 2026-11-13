import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../config/database.js';
import { reconcileDeploymentRoute } from './deployment-routing.js';

const MAX_ATTEMPTS = 10;
const CLAIM_LEASE_MS = 5 * 60_000;
const RETRY_DELAY_MS = 30_000;

interface RoutingEvent {
  id: string;
  deploymentId: string;
  payload: Prisma.JsonValue;
}

export async function processDeploymentRoutingOutbox(): Promise<number> {
  const claimToken = randomUUID();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
  const retryBefore = new Date(now.getTime() - RETRY_DELAY_MS);

  const event = await prisma.$transaction(async (tx) => {
    const events = await tx.$queryRaw<RoutingEvent[]>`
      SELECT "id", "deploymentId", "payload"
      FROM "DeploymentOutbox"
      WHERE "processedAt" IS NULL
        AND "eventType" = 'DEPLOYMENT_ROUTING_REQUESTED'
        AND "attempts" < ${MAX_ATTEMPTS}
        AND (
          (
            "claimToken" IS NULL
            AND (
              "claimedAt" IS NULL
              OR "claimedAt" < ${retryBefore}
            )
          )
          OR (
            "claimToken" IS NOT NULL
            AND "claimedAt" < ${staleBefore}
          )
        )
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;

    const selected = events[0];

    if (!selected) {
      return null;
    }

    await tx.deploymentOutbox.update({
      where: { id: selected.id },
      data: {
        claimToken,
        claimedAt: now,
        attempts: { increment: 1 },
      },
    });

    return selected;
  });

  if (!event) {
    return 0;
  }

  try {
    const payload = event.payload;

    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof payload.deploymentId !== 'string' ||
      typeof payload.projectId !== 'string' ||
      payload.projectId.length === 0 ||
      payload.deploymentId !== event.deploymentId
    ) {
      throw new Error('Invalid deployment routing payload');
    }

    const result = await reconcileDeploymentRoute(payload.deploymentId, payload.projectId);

    const marked = await prisma.deploymentOutbox.updateMany({
      where: {
        id: event.id,
        claimToken,
        processedAt: null,
      },
      data: {
        processedAt: new Date(),
        claimToken: null,
        claimedAt: null,
        lastError: null,
      },
    });

    if (marked.count !== 1) {
      console.warn('Routing event claim was lost.', {
        outboxEventId: event.id,
      });
      return 0;
    }

    console.log('Deployment routing event processed.', {
      deploymentId: event.deploymentId,
      result,
    });

    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown routing error';

    await prisma.deploymentOutbox.updateMany({
      where: {
        id: event.id,
        claimToken,
        processedAt: null,
      },
      data: {
        claimToken: null,
        // Retain the failure time to enforce the retry delay.
        claimedAt: new Date(),
        lastError: message.slice(0, 2_000),
      },
    });

    console.error('Deployment routing event failed.', {
      outboxEventId: event.id,
      deploymentId: event.deploymentId,
      error: message,
    });

    throw error;
  }
}
