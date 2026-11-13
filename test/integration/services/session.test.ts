import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prisma } from '../../../src/config/database.js';
import {
  createSession,
  getSessionUser,
  revokeSession,
  SESSION_TTL_MS,
} from '../../../src/services/session.js';
import { useTestData } from '../../support/test-data.js';

describe('session service', () => {
  const data = useTestData();

  it('expires a session exactly 30 days after creation', async () => {
    const user = await data.createUser({ prefix: 'session', name: 'Session Test User' });

    const beforeCreation = Date.now();
    const session = await createSession(user.id);
    const afterCreation = Date.now();

    assert.ok(
      session.expiresAt.getTime() >= beforeCreation + SESSION_TTL_MS,
      'Expiry must be at least 30 days after the start of creation',
    );
    assert.ok(
      session.expiresAt.getTime() <= afterCreation + SESSION_TTL_MS,
      'Expiry must be no later than 30 days after creation',
    );

    const authenticatedUser = await getSessionUser(session.token);

    assert.ok(authenticatedUser);
    assert.equal(authenticatedUser.id, user.id);

    // Checking the session must not extend its original expiry.
    const storedSession = await prisma.session.findFirst({ where: { userId: user.id } });

    assert.ok(storedSession);
    assert.equal(storedSession.expiresAt.getTime(), session.expiresAt.getTime());
  });

  it('rejects an expired session', async () => {
    const user = await data.createUser({ prefix: 'session', name: 'Session Test User' });
    const session = await createSession(user.id);

    await prisma.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    assert.equal(await getSessionUser(session.token), null);
  });

  it('keeps other sessions valid when one session is revoked', async () => {
    const user = await data.createUser({ prefix: 'session', name: 'Session Test User' });
    const firstSession = await createSession(user.id);
    const secondSession = await createSession(user.id);

    assert.ok(await getSessionUser(firstSession.token));
    assert.ok(await getSessionUser(secondSession.token));

    await revokeSession(firstSession.token);

    assert.equal(await getSessionUser(firstSession.token), null);

    const stillAuthenticated = await getSessionUser(secondSession.token);

    assert.ok(stillAuthenticated);
    assert.equal(stillAuthenticated.id, user.id);
  });
});
