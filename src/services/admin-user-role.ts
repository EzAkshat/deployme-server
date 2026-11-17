import { prisma } from '../config/database.js';
import { recordPlatformRoleChange } from './platform-admin-audit.js';

type ManagedRole = 'USER' | 'SITE_ADMIN';

export class AdminRoleChangeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminRoleChangeError';
  }
}

interface ChangeAdminUserRoleInput {
  actorUserId: number;
  sessionId: string;
  targetUserId: number;
  expectedRole: ManagedRole;
  nextRole: ManagedRole;
  reason: string;
}

export async function changeAdminUserRole(input: ChangeAdminUserRoleInput) {
  const reason = input.reason.trim();

  if (reason.length < 10 || reason.length > 1000) {
    throw new AdminRoleChangeError(400, 'Provide a reason between 10 and 1000 characters.');
  }

  if (input.actorUserId === input.targetUserId) {
    throw new AdminRoleChangeError(403, 'You cannot change your own platform role.');
  }

  return prisma.$transaction(async (tx) => {
    // All callers of this workflow lock accounts in the same order.
    // This serializes competing changes to the same target account.
    await tx.$queryRaw`
      SELECT "id"
      FROM "User"
      WHERE "id" IN (${input.actorUserId}, ${input.targetUserId})
      ORDER BY "id" ASC
      FOR UPDATE
    `;

    const actor = await tx.user.findUnique({
      where: { id: input.actorUserId },
      select: { platformRole: true, suspendedAt: true },
    });

    if (!actor || actor.platformRole !== 'SUPER_ADMIN' || actor.suspendedAt !== null) {
      throw new AdminRoleChangeError(403, 'Active super administrator access required.');
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
      throw new AdminRoleChangeError(401, 'Your session has expired. Sign in again.');
    }

    const target = await tx.user.findUnique({
      where: { id: input.targetUserId },
      select: {
        id: true,
        username: true,
        name: true,
        platformRole: true,
      },
    });

    if (!target) {
      throw new AdminRoleChangeError(404, 'Account not found.');
    }

    if (target.platformRole === 'SUPER_ADMIN') {
      throw new AdminRoleChangeError(403, 'This endpoint cannot modify super administrators.');
    }

    // Prevent a stale browser page from overwriting another admin's change.
    if (target.platformRole !== input.expectedRole) {
      throw new AdminRoleChangeError(
        409,
        'This account’s role has changed. Refresh the user directory.',
      );
    }

    if (target.platformRole === input.nextRole) {
      return { changed: false, user: target };
    }

    const updated = await tx.user.update({
      where: { id: target.id },
      data: {
        platformRole: input.nextRole,
        accountStateVersion: { increment: 1 },
      },
      select: {
        id: true,
        username: true,
        name: true,
        platformRole: true,
      },
    });

    await recordPlatformRoleChange(tx, {
      actorUserId: input.actorUserId,
      targetUserId: target.id,
      actorPlatformRole: actor.platformRole,
      previousRole: target.platformRole,
      nextRole: input.nextRole,
      reason,
    });

    // End existing target sessions after either promotion or demotion.
    // The user must sign in again with their updated permissions.
    await tx.session.updateMany({
      where: {
        userId: target.id,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    return { changed: true, user: updated };
  });
}
