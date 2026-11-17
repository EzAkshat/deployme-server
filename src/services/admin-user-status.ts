import { z } from 'zod';

import { prisma } from '../config/database.js';

export const changeAdminUserStatusSchema = z
  .object({
    expectedVersion: z.number().int().min(0).max(2_147_483_646),
    suspended: z.boolean(),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();

export class AdminUserStatusError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminUserStatusError';
  }
}

interface ChangeAdminUserStatusInput {
  actorUserId: number;
  sessionId: string;
  targetUserId: number;
  expectedVersion: number;
  suspended: boolean;
  reason: string;
}

export async function changeAdminUserStatus(input: ChangeAdminUserStatusInput) {
  const parsed = changeAdminUserStatusSchema.safeParse({
    expectedVersion: input.expectedVersion,
    suspended: input.suspended,
    reason: input.reason,
  });

  if (!parsed.success) {
    throw new AdminUserStatusError(
      400,
      'Provide the current account version, suspension status, and a reason between 10 and 1000 characters.',
    );
  }

  if (input.actorUserId === input.targetUserId) {
    throw new AdminUserStatusError(403, 'You cannot suspend or restore your own account.');
  }

  const { expectedVersion, suspended, reason } = parsed.data;

  return prisma.$transaction(async (tx) => {
    // Match the role-change workflow's lock order.
    // Deployment guards and session creation also lock the owner User row.
    await tx.$queryRaw`
      SELECT "id"
      FROM "User"
      WHERE "id" IN (${input.actorUserId}, ${input.targetUserId})
      ORDER BY "id" ASC
      FOR UPDATE
    `;

    const actor = await tx.user.findUnique({
      where: { id: input.actorUserId },
      select: {
        platformRole: true,
        suspendedAt: true,
      },
    });

    if (
      !actor ||
      actor.suspendedAt !== null ||
      (actor.platformRole !== 'SUPER_ADMIN' && actor.platformRole !== 'SITE_ADMIN')
    ) {
      throw new AdminUserStatusError(403, 'Active administrator access required.');
    }

    const session = await tx.session.findFirst({
      where: {
        id: input.sessionId,
        userId: input.actorUserId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!session) {
      throw new AdminUserStatusError(401, 'Your session has expired. Sign in again.');
    }

    const select = {
      id: true,
      username: true,
      name: true,
      platformRole: true,
      suspendedAt: true,
      accountStateVersion: true,
    } as const;

    const target = await tx.user.findUnique({
      where: { id: input.targetUserId },
      select,
    });

    if (!target) {
      throw new AdminUserStatusError(404, 'Account not found.');
    }

    if (target.platformRole === 'SUPER_ADMIN') {
      throw new AdminUserStatusError(
        403,
        'This endpoint cannot suspend or restore super administrators.',
      );
    }

    if (actor.platformRole === 'SITE_ADMIN' && target.platformRole !== 'USER') {
      throw new AdminUserStatusError(
        403,
        'Site administrators can only suspend or restore ordinary user accounts.',
      );
    }

    if (target.accountStateVersion !== expectedVersion) {
      throw new AdminUserStatusError(
        409,
        'This account has changed. Refresh the user directory before trying again.',
      );
    }

    const currentlySuspended = target.suspendedAt !== null;

    if (currentlySuspended === suspended) {
      return { changed: false, user: target };
    }

    const now = new Date();
    const nextSuspendedAt = suspended ? now : null;

    const updated = await tx.user.update({
      where: { id: target.id },
      data: {
        suspendedAt: nextSuspendedAt,
        accountStateVersion: { increment: 1 },
      },
      select,
    });

    if (suspended) {
      await tx.session.updateMany({
        where: {
          userId: target.id,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
    }

    // Restoration never reactivates revoked sessions.
    await tx.platformAdminAudit.create({
      data: {
        actorUserId: input.actorUserId,
        targetUserId: target.id,
        actorPlatformRole: actor.platformRole,
        action: suspended ? 'USER_SUSPENDED' : 'USER_RESTORED',
        reason,
        previousRole: target.platformRole,
        nextRole: target.platformRole,
        previousSuspendedAt: target.suspendedAt,
        nextSuspendedAt,
      },
    });

    return { changed: true, user: updated };
  });
}
