import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  after,
  afterEach,
  beforeEach,
  describe,
  it,
} from 'node:test';
import request from 'supertest';

import app from '../../../src/app.js';
import { prisma } from '../../../src/config/database.js';
import { env } from '../../../src/config/env.js';

const trustedOrigin = new URL(
  env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
).origin;

describe('administrator account-status HTTP protection', {
  concurrency: false,
}, () => {
  let userIds: number[] = [];
  let actorId: number;
  let targetId: number;
  let actorCookie: string;

  async function createUser(
    platformRole: 'USER' | 'SITE_ADMIN' | 'SUPER_ADMIN',
  ) {
    const suffix = randomUUID().replaceAll('-', '');

    const user = await prisma.user.create({
      data: {
        username: `status_http_${suffix}`,
        email: `status-http-${suffix}@example.com`,
        name: 'Status HTTP Test',
        platformRole,
      },
    });

    userIds.push(user.id);
    return user;
  }

  async function createCookie(userId: number) {
    const token = randomBytes(32).toString('base64url');

    await prisma.session.create({
      data: {
        userId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    return `deployme_session=${token}`;
  }

  function endpoint() {
    return `/admin/users/${targetId}/status`;
  }

  function body() {
    return {
      expectedVersion: 0,
      suspended: true,
      reason: 'Account suspension requested through the HTTP test.',
    };
  }

  async function assertUnchanged() {
    const target = await prisma.user.findUniqueOrThrow({
      where: { id: targetId },
    });

    assert.equal(target.suspendedAt, null);
    assert.equal(target.accountStateVersion, 0);

    assert.equal(
      await prisma.platformAdminAudit.count({
        where: { targetUserId: targetId },
      }),
      0,
    );
  }

  beforeEach(async () => {
    userIds = [];

    const actor = await createUser('SUPER_ADMIN');
    const target = await createUser('USER');

    actorId = actor.id;
    targetId = target.id;
    actorCookie = await createCookie(actorId);
  });

  afterEach(async () => {
    if (userIds.length === 0) return;

    await prisma.platformAdminAudit.deleteMany({
      where: {
        OR: [
          { actorUserId: { in: userIds } },
          { targetUserId: { in: userIds } },
        ],
      },
    });

    await prisma.session.deleteMany({
      where: { userId: { in: userIds } },
    });

    await prisma.user.deleteMany({
      where: { id: { in: userIds } },
    });
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('rejects unauthenticated requests', async () => {
    await request(app)
      .patch(endpoint())
      .set('Origin', trustedOrigin)
      .send(body())
      .expect(401);

    await assertUnchanged();
  });

  it('rejects authenticated ordinary users', async () => {
    const ordinary = await createUser('USER');
    const cookie = await createCookie(ordinary.id);

    await request(app)
      .patch(endpoint())
      .set('Cookie', cookie)
      .set('Origin', trustedOrigin)
      .send(body())
      .expect(403);

    await assertUnchanged();
  });

  it('rejects an administrator request without an Origin header', async () => {
    await request(app)
      .patch(endpoint())
      .set('Cookie', actorCookie)
      .send(body())
      .expect(403);

    await assertUnchanged();
  });

  it('rejects an untrusted Origin', async () => {
    await request(app)
      .patch(endpoint())
      .set('Cookie', actorCookie)
      .set('Origin', 'https://untrusted-admin-test.invalid')
      .send(body())
      .expect(403);

    await assertUnchanged();
  });

  it('rejects malformed request bodies', async () => {
    const invalidBodies = [
      { ...body(), reason: 'short' },
      { ...body(), expectedVersion: -1 },
      { ...body(), suspended: 'true' },
      { ...body(), unexpected: true },
    ];

    for (const invalid of invalidBodies) {
      await request(app)
        .patch(endpoint())
        .set('Cookie', actorCookie)
        .set('Origin', trustedOrigin)
        .send(invalid)
        .expect(400);
    }

    await assertUnchanged();
  });

  it('rejects a suspended administrator even with an unrevoked session', async () => {
    // Deliberately leave the session unrevoked to verify the account check.
    await prisma.user.update({
      where: { id: actorId },
      data: { suspendedAt: new Date() },
    });

    await request(app)
      .patch(endpoint())
      .set('Cookie', actorCookie)
      .set('Origin', trustedOrigin)
      .send(body())
      .expect(401);

    await assertUnchanged();
  });

  it('suspends and restores through HTTP without reviving the old session', async () => {
    const targetCookie = await createCookie(targetId);

    const suspended = await request(app)
      .patch(endpoint())
      .set('Cookie', actorCookie)
      .set('Origin', trustedOrigin)
      .send(body())
      .expect(200);

    assert.equal(suspended.body.changed, true);
    assert.equal(suspended.body.user.accountStateVersion, 1);
    assert.equal(typeof suspended.body.user.suspendedAt, 'string');
    assert.match(
      suspended.headers['cache-control'] ?? '',
      /no-store/,
    );

    await request(app)
      .get('/auth/me')
      .set('Cookie', targetCookie)
      .expect(401);

    // A stale browser cannot overwrite the suspension.
    await request(app)
      .patch(endpoint())
      .set('Cookie', actorCookie)
      .set('Origin', trustedOrigin)
      .send({ ...body(), suspended: false })
      .expect(409);

    const restored = await request(app)
      .patch(endpoint())
      .set('Cookie', actorCookie)
      .set('Origin', trustedOrigin)
      .send({
        expectedVersion: 1,
        suspended: false,
        reason: 'Account reviewed and restored through the HTTP test.',
      })
      .expect(200);

    assert.equal(restored.body.changed, true);
    assert.equal(restored.body.user.suspendedAt, null);
    assert.equal(restored.body.user.accountStateVersion, 2);

    await request(app)
      .get('/auth/me')
      .set('Cookie', targetCookie)
      .expect(401);

    assert.equal(
      await prisma.platformAdminAudit.count({
        where: { targetUserId: targetId },
      }),
      2,
    );
  });
});