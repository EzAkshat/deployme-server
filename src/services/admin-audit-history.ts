import { z } from 'zod';

import { prisma } from '../config/database.js';

const PAGE_SIZE = 25;

const cursorPayloadSchema = z.tuple([
  z.string().datetime(),
  z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
]);

export class AdminAuditHistoryInputError extends Error {
  constructor() {
    super('Invalid audit history cursor.');
    this.name = 'AdminAuditHistoryInputError';
  }
}

function decodeCursor(value: string) {
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error('Invalid cursor encoding.');
    }

    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

    const [timestamp, id] = cursorPayloadSchema.parse(decoded);
    const createdAt = new Date(timestamp);

    if (!Number.isFinite(createdAt.getTime())) {
      throw new Error('Invalid timestamp.');
    }

    return { createdAt, id };
  } catch {
    throw new AdminAuditHistoryInputError();
  }
}

export async function getAdminAuditHistory(before?: string) {
  const cursor = before ? decodeCursor(before) : null;

  const rows = await prisma.platformAdminAudit.findMany({
    where: cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            {
              createdAt: cursor.createdAt,
              id: { lt: cursor.id },
            },
          ],
        }
      : {},
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PAGE_SIZE + 1,
    select: {
      id: true,
      action: true,
      actorPlatformRole: true,
      previousRole: true,
      nextRole: true,
      reason: true,
      createdAt: true,
      previousSuspendedAt: true,
      nextSuspendedAt: true,
      actor: {
        select: {
          id: true,
          username: true,
          name: true,
        },
      },
      target: {
        select: {
          id: true,
          username: true,
          name: true,
        },
      },
    },
  });

  const entries = rows.slice(0, PAGE_SIZE);
  const last = entries.at(-1);

  return {
    entries,
    nextCursor:
      rows.length > PAGE_SIZE && last
        ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last.id])).toString('base64url')
        : null,
  };
}
