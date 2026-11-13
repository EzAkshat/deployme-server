import { randomUUID } from 'node:crypto';

import { prisma } from '../config/database.js';
import { disableArchivedProjectRoute } from './project-route-disable.js';

const CLAIM_LEASE_MS = 5 * 60_000;
const INITIAL_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

interface ArchiveEvent {
  id: string;
  projectId: string;
  attempts: number;
}

export async function claimProjectArchiveEvent(
  claimToken: string,
  now: Date = new Date(),
): Promise<ArchiveEvent | null> {
  const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS);

  return prisma.$transaction(async (tx) => {
    const events = await tx.$queryRaw<ArchiveEvent[]>`
      SELECT "id", "projectId", "attempts"
      FROM "ProjectArchiveOutbox"
      WHERE "processedAt" IS NULL
        AND "nextAttemptAt" <= ${now}
        AND (
          "claimToken" IS NULL
          OR "claimedAt" < ${staleBefore}
        )
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC, "id" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;

    const selected = events[0];

    if (!selected) return null;

    await tx.projectArchiveOutbox.update({
      where: { id: selected.id },
      data: {
        claimToken,
        claimedAt: now,
        attempts: { increment: 1 },
      },
    });

    return {
      ...selected,
      attempts: selected.attempts + 1,
    };
  });
}

export async function processProjectArchiveOutbox(): Promise<number> {
  const claimToken = randomUUID();
  const event = await claimProjectArchiveEvent(claimToken);

  if (!event) return 0;

  return processClaimedProjectArchiveEvent(event, claimToken);
}
export async function processClaimedProjectArchiveEvent(
  event: ArchiveEvent,
  claimToken: string,
  disableRoute: typeof disableArchivedProjectRoute = disableArchivedProjectRoute,
): Promise<number> {
  try {
    const result = await disableRoute(event.projectId);
    const marked = await prisma.projectArchiveOutbox.updateMany({
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
      console.warn('Project archive event claim was lost.', {
        outboxEventId: event.id,
        projectId: event.projectId,
      });

      return 0;
    }

    console.log('Archived project delivery disabled.', {
      projectId: event.projectId,
      result,
    });

    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown archive error';

    const retryDelay = Math.min(
      MAX_RETRY_DELAY_MS,
      INITIAL_RETRY_DELAY_MS * 2 ** Math.min(event.attempts - 1, 4),
    );

    const scheduled = await prisma.projectArchiveOutbox.updateMany({
      where: {
        id: event.id,
        claimToken,
        processedAt: null,
      },
      data: {
        claimToken: null,
        claimedAt: null,
        nextAttemptAt: new Date(Date.now() + retryDelay),
        lastError: message.slice(0, 2_000),
      },
    });

    console.error('Project archive delivery update failed; retry scheduled.', {
      outboxEventId: event.id,
      projectId: event.projectId,
      attempts: event.attempts,
      error: message,
    });
    if (scheduled.count === 1) {
      console.error('Project archive delivery update failed; retry scheduled.', {
        outboxEventId: event.id,
        projectId: event.projectId,
        attempts: event.attempts,
        error: message.slice(0, 2_000),
      });
    } else {
      console.warn('Project archive failure ignored because the claim was lost.', {
        outboxEventId: event.id,
        projectId: event.projectId,
        error: message.slice(0, 2_000),
      });
    }
    throw error;
  }
}
