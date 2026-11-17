import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../config/database.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = 'deployme_session';

const hashSessionToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export async function createSession(userId: number) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);

  const expiresAt = await prisma.$transaction(async (tx) => {
    // Suspension must lock this same user row before changing
    // account state and revoking sessions.
    await tx.$queryRaw`
      SELECT "id"
      FROM "User"
      WHERE "id" = ${userId}
      FOR UPDATE
    `;

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        suspendedAt: true,
      },
    });

    if (!user || user.suspendedAt !== null) {
      throw new AccountUnavailableError();
    }

    const expiry = new Date(Date.now() + SESSION_TTL_MS);

    await tx.session.create({
      data: {
        userId,
        tokenHash,
        expiresAt: expiry,
      },
    });

    return expiry;
  });

  return { token, expiresAt };
}

export async function getActiveSession(token: string) {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });

  if (
    !session ||
    session.revokedAt !== null ||
    session.expiresAt.getTime() <= Date.now() ||
    session.user.suspendedAt !== null
  ) {
    return null;
  }

  return session;
}

export async function getSessionUser(token: string) {
  const session = await getActiveSession(token);
  return session?.user ?? null;
}

export async function revokeSession(token: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
    return;
  }

  await prisma.session.updateMany({
    where: {
      tokenHash: hashSessionToken(token),
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
}

export class AccountUnavailableError extends Error {
  constructor() {
    super('This account cannot sign in.');
    this.name = 'AccountUnavailableError';
  }
}
