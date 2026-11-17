import { prisma } from '../config/database.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    throw new Error(
      'Usage: bootstrap-super-admin <existing-email> "<reason>"',
    );
  }

  const email = args[0]!.trim().toLowerCase();
  const operatorReason = args[1]!.trim();

  if (!email || email.length > 254 || !email.includes('@')) {
    throw new Error('Provide a valid existing account email.');
  }

  if (operatorReason.length < 10 || operatorReason.length > 800) {
    throw new Error('Provide a reason between 10 and 800 characters.');
  }

  const reason =
    '[INITIAL_SUPER_ADMIN_BOOTSTRAP] Executed by a server operator; ' +
    'actor account denotes the bootstrap recipient. ' +
    operatorReason;

  const result = await prisma.$transaction(
    async (tx) => {
      // Serialize bootstrap attempts before checking for a super admin.
      // This briefly blocks other writes to User.
      await tx.$executeRaw`
        LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE
      `;

      const existing = await tx.user.findFirst({
        where: { platformRole: 'SUPER_ADMIN' },
        select: { id: true },
      });

      if (existing) {
        throw new Error(
          'A super administrator already exists. Bootstrap refused.',
        );
      }

      const target = await tx.user.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          platformRole: true,
          suspendedAt: true,
          onboardingCompletedAt: true,
        },
      });

      if (!target) {
        throw new Error(
          'Account not found. Sign in through the regular application first.',
        );
      }

      if (target.suspendedAt !== null) {
        throw new Error('A suspended account cannot be bootstrapped.');
      }

      if (target.onboardingCompletedAt === null) {
        throw new Error(
          'Complete onboarding through the regular application first.',
        );
      }

      const user = await tx.user.update({
        where: { id: target.id },
        data: {
          platformRole: 'SUPER_ADMIN',
          accountStateVersion: { increment: 1 },
        },
        select: {
          id: true,
          email: true,
          platformRole: true,
          accountStateVersion: true,
        },
      });

      // Intentional bootstrap exception:
      // no existing administrator is available to act.
      // Do not use or weaken the normal role-change helper.
      const audit = await tx.platformAdminAudit.create({
        data: {
          actorUserId: target.id,
          targetUserId: target.id,
          actorPlatformRole: target.platformRole,
          action: 'USER_PLATFORM_ROLE_CHANGED',
          previousRole: target.platformRole,
          nextRole: 'SUPER_ADMIN',
          reason,
        },
        select: { id: true },
      });

      const sessions = await tx.session.updateMany({
        where: {
          userId: target.id,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });

      return {
        user,
        auditId: audit.id,
        revokedSessions: sessions.count,
      };
    },
    {
      isolationLevel: 'ReadCommitted',
      maxWait: 5_000,
      timeout: 15_000,
    },
  );

  console.log('Initial super administrator created.');
  console.log(JSON.stringify(result, null, 2));
  console.log('Sign in again through the administrator login page.');
}

try {
  await main();
} catch (error: unknown) {
  console.error(
    error instanceof Error ? error.message : 'Bootstrap failed.',
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}