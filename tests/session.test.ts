import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { prisma } from '../src/config/database.js';
import {
  createSession,
  getSessionUser,
  revokeSession,
  SESSION_TTL_MS,
} from '../src/services/session.js';

after(async () => {
  await prisma.$disconnect();
});

async function createTestUser() {
  const uniqueId = randomUUID();

  return prisma.user.create({
    data: {
      username: `session_${uniqueId.replaceAll('-', '').slice(0, 12)}`,
      name: 'Session Test User',
      email: `session.${uniqueId}@example.com`,
    },
  });
}

test('a session expires exactly 30 days after creation', async () => {
  const user = await createTestUser();

  try {
    const beforeCreation = Date.now();
    const session = await createSession(user.id);
    const afterCreation = Date.now();

    const expectedMinimum = beforeCreation + SESSION_TTL_MS;
    const expectedMaximum = afterCreation + SESSION_TTL_MS;

    assert.ok(
      session.expiresAt.getTime() >= expectedMinimum,
      'Expiry must be at least 30 days after the start of creation',
    );
    assert.ok(
      session.expiresAt.getTime() <= expectedMaximum,
      'Expiry must be no later than 30 days after creation',
    );

    const authenticatedUser = await getSessionUser(session.token);

    assert.ok(authenticatedUser);
    assert.equal(authenticatedUser.id, user.id);

    // Checking the session must not extend its original expiry.
    const storedSession = await prisma.session.findFirst({
      where: { userId: user.id },
    });

    assert.ok(storedSession);
    assert.equal(storedSession.expiresAt.getTime(), session.expiresAt.getTime());
  } finally {
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('an expired session is rejected', async () => {
  const user = await createTestUser();

  try {
    const session = await createSession(user.id);

    await prisma.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const authenticatedUser = await getSessionUser(session.token);

    assert.equal(authenticatedUser, null);
  } finally {
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('revoking one session does not revoke another session', async () => {
  const user = await createTestUser();

  try {
    const firstSession = await createSession(user.id);
    const secondSession = await createSession(user.id);

    assert.ok(await getSessionUser(firstSession.token));
    assert.ok(await getSessionUser(secondSession.token));

    await revokeSession(firstSession.token);

    assert.equal(await getSessionUser(firstSession.token), null);

    const stillAuthenticated = await getSessionUser(secondSession.token);

    assert.ok(stillAuthenticated);
    assert.equal(stillAuthenticated.id, user.id);
  } finally {
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});
