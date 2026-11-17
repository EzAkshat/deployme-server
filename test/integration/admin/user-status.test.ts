import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  after,
  afterEach,
  beforeEach,
  describe,
  it,
} from 'node:test';

import { prisma } from '../../../src/config/database.js';
import {
  AdminUserStatusError,
  changeAdminUserStatus,
} from '../../../src/services/admin-user-status.js';

describe('administrator account suspension', { concurrency: false }, () => {
  let userIds: number[] = [];
  let actorId: number;
  let targetId: number;
  let actorSessionId: string;

  async function createUser(
    platformRole: 'USER' | 'SITE_ADMIN' | 'SUPER_ADMIN',
  ) {
    const suffix = randomUUID().replaceAll('-', '');

    const user = await prisma.user.create({
      data: {
        email: `status-${suffix}@example.com`,
        username: `status_${suffix}`,
        name: 'Account Status Test',
        platformRole,
      },
    });

    userIds.push(user.id);
    return user;
  }

  async function createSession(userId: number) {
    return prisma.session.create({
      data: {
        userId,
        tokenHash: randomUUID().replaceAll('-', '').repeat(2),
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
  }

  function change(
    overrides: Partial<Parameters<typeof changeAdminUserStatus>[0]> = {},
  ) {
    return changeAdminUserStatus({
      actorUserId: actorId,
      sessionId: actorSessionId,
      targetUserId: targetId,
      expectedVersion: 0,
      suspended: true,
      reason: 'Suspension requested for integration testing.',
      ...overrides,
    });
  }

  function rejectsWithStatus(status: number) {
    return (error: unknown) =>
      error instanceof AdminUserStatusError &&
      error.status === status;
  }

  beforeEach(async () => {
    userIds = [];

    const actor = await createUser('SUPER_ADMIN');
    const target = await createUser('USER');
    const session = await createSession(actor.id);

    actorId = actor.id;
    targetId = target.id;
    actorSessionId = session.id;
  });

  afterEach(async () => {
    if (userIds.length === 0) return;

    // Delete only records created by this test.
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

  it('suspends, revokes all target sessions, and records the change', async () => {
    await createSession(targetId);
    await createSession(targetId);

    const result = await change();

    assert.equal(result.changed, true);
    assert.ok(result.user.suspendedAt instanceof Date);
    assert.equal(result.user.accountStateVersion, 1);

    const sessions = await prisma.session.findMany({
      where: { userId: targetId },
    });

    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((session) => session.revokedAt !== null));

    const actorSession = await prisma.session.findUniqueOrThrow({
      where: { id: actorSessionId },
    });

    assert.equal(actorSession.revokedAt, null);

    const audits = await prisma.platformAdminAudit.findMany({
      where: { targetUserId: targetId },
    });

    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.action, 'USER_SUSPENDED');
    assert.equal(audits[0]!.actorUserId, actorId);
    assert.equal(audits[0]!.previousRole, 'USER');
    assert.equal(audits[0]!.nextRole, 'USER');
    assert.equal(audits[0]!.previousSuspendedAt, null);
    assert.equal(
      audits[0]!.nextSuspendedAt?.getTime(),
      result.user.suspendedAt.getTime(),
    );
  });

  it('restores access without reviving old sessions', async () => {
    const session = await createSession(targetId);
    const suspended = await change();

    const restored = await change({
      expectedVersion: 1,
      suspended: false,
      reason: 'Account reviewed and approved for restoration.',
    });

    assert.equal(restored.changed, true);
    assert.equal(restored.user.suspendedAt, null);
    assert.equal(restored.user.accountStateVersion, 2);

    const oldSession = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });

    assert.ok(oldSession.revokedAt !== null);

    const audit = await prisma.platformAdminAudit.findFirstOrThrow({
      where: {
        targetUserId: targetId,
        action: 'USER_RESTORED',
      },
    });

    assert.equal(
      audit.previousSuspendedAt?.getTime(),
      suspended.user.suspendedAt?.getTime(),
    );
    assert.equal(audit.nextSuspendedAt, null);
  });

  it('allows a site administrator to manage users but not administrators', async () => {
    await prisma.user.update({
      where: { id: actorId },
      data: { platformRole: 'SITE_ADMIN' },
    });

    assert.equal((await change()).changed, true);

    const siteAdmin = await createUser('SITE_ADMIN');

    await assert.rejects(
      change({ targetUserId: siteAdmin.id }),
      rejectsWithStatus(403),
    );

    const unchanged = await prisma.user.findUniqueOrThrow({
      where: { id: siteAdmin.id },
    });

    assert.equal(unchanged.suspendedAt, null);
    assert.equal(
      await prisma.platformAdminAudit.count({
        where: { targetUserId: siteAdmin.id },
      }),
      0,
    );
  });

  it('allows a super administrator to suspend a site administrator', async () => {
    await prisma.user.update({
      where: { id: targetId },
      data: { platformRole: 'SITE_ADMIN' },
    });

    const result = await change();

    assert.equal(result.changed, true);
    assert.equal(result.user.platformRole, 'SITE_ADMIN');
    assert.ok(result.user.suspendedAt !== null);
  });

  it('rejects self-modification and protected super administrators', async () => {
    await assert.rejects(
      change({ targetUserId: actorId }),
      rejectsWithStatus(403),
    );

    const protectedUser = await createUser('SUPER_ADMIN');

    await assert.rejects(
      change({ targetUserId: protectedUser.id }),
      rejectsWithStatus(403),
    );

    assert.equal(
      await prisma.platformAdminAudit.count({
        where: { actorUserId: actorId },
      }),
      0,
    );
  });

  it('rejects revoked, expired, and another user’s sessions', async () => {
    await prisma.session.update({
      where: { id: actorSessionId },
      data: { revokedAt: new Date() },
    });

    await assert.rejects(change(), rejectsWithStatus(401));

    await prisma.session.update({
      where: { id: actorSessionId },
      data: {
        revokedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    await assert.rejects(change(), rejectsWithStatus(401));

    const otherSession = await createSession(targetId);

    await assert.rejects(
      change({ sessionId: otherSession.id }),
      rejectsWithStatus(401),
    );

    const target = await prisma.user.findUniqueOrThrow({
      where: { id: targetId },
    });

    assert.equal(target.suspendedAt, null);
    assert.equal(target.accountStateVersion, 0);
  });

  it('rechecks the actor’s suspension and role inside the transaction', async () => {
    await prisma.user.update({
      where: { id: actorId },
      data: { suspendedAt: new Date() },
    });

    await assert.rejects(change(), rejectsWithStatus(403));

    await prisma.user.update({
      where: { id: actorId },
      data: {
        suspendedAt: null,
        platformRole: 'USER',
      },
    });

    await assert.rejects(change(), rejectsWithStatus(403));

    assert.equal(
      await prisma.platformAdminAudit.count({
        where: { targetUserId: targetId },
      }),
      0,
    );
  });

  it('rejects stale updates and leaves repeated current-state requests unchanged', async () => {
    await change();

    await assert.rejects(
      change({ suspended: false }),
      rejectsWithStatus(409),
    );

    const repeated = await change({ expectedVersion: 1 });

    assert.equal(repeated.changed, false);
    assert.equal(repeated.user.accountStateVersion, 1);

    assert.equal(
      await prisma.platformAdminAudit.count({
        where: { targetUserId: targetId },
      }),
      1,
    );
  });

  it('allows only one competing update using the same account version', async () => {
    const results = await Promise.allSettled([
      change(),
      change(),
    ]);

    const successful = results.filter(
      (result) => result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result) => result.status === 'rejected',
    );

    assert.equal(successful.length, 1);
    assert.equal(rejected.length, 1);

    const failure = rejected[0];
    assert.ok(failure?.status === 'rejected');
    assert.ok(rejectsWithStatus(409)(failure.reason));

    const target = await prisma.user.findUniqueOrThrow({
      where: { id: targetId },
    });

    assert.equal(target.accountStateVersion, 1);
    assert.ok(target.suspendedAt !== null);

    assert.equal(
      await prisma.platformAdminAudit.count({
        where: { targetUserId: targetId },
      }),
      1,
    );
  });
});