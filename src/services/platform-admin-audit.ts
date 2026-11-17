import type { PlatformRole, Prisma } from '../generated/prisma/client.js';

interface RecordPlatformRoleChangeInput {
  actorUserId: number;
  targetUserId: number;
  actorPlatformRole: PlatformRole;
  previousRole: PlatformRole;
  nextRole: PlatformRole;
  reason: string;
}

// Internal helper: call inside the same transaction as the role update.
// Authorization and user locking belong to the role-change service.
export async function recordPlatformRoleChange(
  tx: Prisma.TransactionClient,
  input: RecordPlatformRoleChangeInput,
): Promise<void> {
  const reason = input.reason.trim();

  if (reason.length < 10 || reason.length > 1000) {
    throw new Error('Provide an administrative reason between 10 and 1000 characters.');
  }

  if (
    !Number.isSafeInteger(input.actorUserId) ||
    input.actorUserId <= 0 ||
    !Number.isSafeInteger(input.targetUserId) ||
    input.targetUserId <= 0
  ) {
    throw new Error('Invalid administrator or target account.');
  }

  if (input.actorPlatformRole !== 'SUPER_ADMIN') {
    throw new Error('Only a super administrator can record a platform role change.');
  }

  if (input.actorUserId === input.targetUserId) {
    throw new Error('Administrators cannot change their own platform role.');
  }

  if (input.previousRole === input.nextRole) {
    throw new Error('The account already has the requested role.');
  }

  // The initial workflow supports USER <-> SITE_ADMIN only.
  if (input.previousRole === 'SUPER_ADMIN' || input.nextRole === 'SUPER_ADMIN') {
    throw new Error('Super administrator changes require a separate workflow.');
  }

  await tx.platformAdminAudit.create({
    data: {
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
      actorPlatformRole: input.actorPlatformRole,
      action: 'USER_PLATFORM_ROLE_CHANGED',
      reason,
      previousRole: input.previousRole,
      nextRole: input.nextRole,
    },
  });
}
