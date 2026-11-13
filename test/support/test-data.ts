import { after } from 'node:test';
import { prisma } from '../../src/config/database.js';
import { uniqueEmail, uniqueUsername } from './ids.js';

export interface CreateUserOptions {
  /** Used in the generated email and username. Letters, digits and underscores. */
  prefix?: string;
  name?: string;
  platformRole?: 'USER' | 'SITE_ADMIN';
}

/** Disconnects Prisma once every test in the current file has finished. */
export function disconnectPrismaAfterAll(): void {
  after(async () => {
    await prisma.$disconnect();
  });
}

/**
 * Creates unique test data and removes everything it created after the
 * surrounding suite finishes (and disconnects Prisma). Replaces the per-test
 * try/finally cleanup blocks.
 *
 * Call it once at the top of a file or `describe` block:
 *
 *   const data = useTestData();
 *   const email = data.newEmail('verify'); // tracked, so cleaned up automatically
 *
 * Cleanup is keyed by email: sessions, OTP challenges and users that belong to
 * a tracked email are deleted. Teams are deleted by id.
 */
export function useTestData() {
  const emails = new Set<string>();
  const teamIds = new Set<string>();

  async function cleanup(): Promise<void> {
    const emailList = [...emails];
    const teamIdList = [...teamIds];

    if (teamIdList.length > 0) {
      await prisma.team.deleteMany({ where: { id: { in: teamIdList } } });
    }

    if (emailList.length === 0) {
      return;
    }

    const users = await prisma.user.findMany({
      where: { email: { in: emailList } },
      select: { id: true },
    });

    if (users.length > 0) {
      await prisma.session.deleteMany({
        where: { userId: { in: users.map((user) => user.id) } },
      });
    }

    await prisma.otpChallenge.deleteMany({ where: { email: { in: emailList } } });
    await prisma.user.deleteMany({ where: { email: { in: emailList } } });
  }

  after(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  });

  return {
    /** A unique email that is deleted (with its user, sessions and OTPs) after the suite. */
    newEmail(prefix: string): string {
      const email = uniqueEmail(prefix);

      emails.add(email);

      return email;
    },

    trackEmail(email: string): void {
      emails.add(email.trim().toLowerCase());
    },

    trackTeam(teamId: string): void {
      teamIds.add(teamId);
    },

    /** Inserts a user directly into the database. Cleaned up automatically. */
    async createUser({
      prefix = 'user',
      name = 'Test User',
      platformRole,
    }: CreateUserOptions = {}) {
      const email = uniqueEmail(prefix);

      emails.add(email);

      return prisma.user.create({
        data: {
          username: uniqueUsername(prefix),
          name,
          email,
          ...(platformRole ? { platformRole } : {}),
        },
      });
    },
  };
}

export type TestData = ReturnType<typeof useTestData>;
