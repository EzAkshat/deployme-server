import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../config/database.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = 'deployme_session';

const hashSessionToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export async function createSession(userId: number) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  });

  // Return the raw token only to the caller so it can set the cookie.
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

  if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
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
