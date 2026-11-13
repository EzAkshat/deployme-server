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
  claimProjectArchiveEvent,
} from '../../../src/services/project-archive-outbox.js';

const NOW = new Date('2000-01-01T12:00:00.000Z');
const LEASE_MS = 5 * 60_000;

describe('archive outbox event claims', () => {
  let ownerId: number | undefined;
  let eventId: string;
  let projectId: string;

  beforeEach(async () => {
    const suffix = randomUUID().replaceAll('-', '');

    const owner = await prisma.user.create({
      data: {
        email: `archive-claims-${suffix}@example.com`,
        username: `ac_${suffix.slice(0, 16)}`,
        name: 'Archive Claims Test',
      },
    });
    ownerId = owner.id;

    const project = await prisma.project.create({
      data: {
        ownerUserId: owner.id,
        name: 'Archive Claims Test',
        slug: `ac-${suffix}`,
        archivedAt: NOW,
      },
    });
    projectId = project.id;

    const event = await prisma.projectArchiveOutbox.create({
      data: {
        projectId,
        createdAt: new Date(NOW.getTime() - 60_000),
        nextAttemptAt: NOW,
      },
    });
    eventId = event.id;
  });

  afterEach(async () => {
    if (ownerId !== undefined) {
      await prisma.project.deleteMany({
        where: { ownerUserId: ownerId },
      });
      await prisma.user.deleteMany({
        where: { id: ownerId },
      });
      ownerId = undefined;
    }
  });

  after(async () => {
    await prisma.$disconnect();
  });

  function readEvent() {
    return prisma.projectArchiveOutbox.findUniqueOrThrow({
      where: { id: eventId },
    });
  }

  it('claims an event when its retry time is due', async () => {
    const token = randomUUID();
    const result = await claimProjectArchiveEvent(token, NOW);

    assert.deepEqual(result, {
      id: eventId,
      projectId,
      attempts: 1,
    });

    const event = await readEvent();

    assert.equal(event.claimToken, token);
    assert.equal(event.claimedAt?.getTime(), NOW.getTime());
    assert.equal(event.attempts, 1);
    assert.equal(event.processedAt, null);
  });

  it('leaves a future retry untouched until it becomes due', async () => {
    const dueAt = new Date(NOW.getTime() + 30_000);

    await prisma.projectArchiveOutbox.update({
      where: { id: eventId },
      data: { nextAttemptAt: dueAt },
    });

    const before = await readEvent();

    assert.equal(
      await claimProjectArchiveEvent(randomUUID(), NOW),
      null,
    );
    assert.deepEqual(await readEvent(), before);

    const result = await claimProjectArchiveEvent(
      randomUUID(),
      dueAt,
    );

    assert.equal(result?.id, eventId);
    assert.equal(result?.attempts, 1);
  });

  it('does not replace a claim whose lease is still active', async () => {
    await prisma.projectArchiveOutbox.update({
      where: { id: eventId },
      data: {
        claimToken: randomUUID(),
        claimedAt: new Date(NOW.getTime() - 60_000),
        attempts: 1,
      },
    });

    const before = await readEvent();

    assert.equal(
      await claimProjectArchiveEvent(randomUUID(), NOW),
      null,
    );
    assert.deepEqual(await readEvent(), before);
  });

  it('reclaims an expired lease and increments its attempt count', async () => {
    await prisma.projectArchiveOutbox.update({
      where: { id: eventId },
      data: {
        claimToken: randomUUID(),
        claimedAt: new Date(NOW.getTime() - LEASE_MS - 1),
        attempts: 3,
      },
    });

    const replacementToken = randomUUID();
    const result = await claimProjectArchiveEvent(
      replacementToken,
      NOW,
    );

    assert.deepEqual(result, {
      id: eventId,
      projectId,
      attempts: 4,
    });

    const event = await readEvent();

    assert.equal(event.claimToken, replacementToken);
    assert.equal(event.claimedAt?.getTime(), NOW.getTime());
    assert.equal(event.attempts, 4);
  });

  it('preserves a claim exactly at the lease boundary', async () => {
    await prisma.projectArchiveOutbox.update({
      where: { id: eventId },
      data: {
        claimToken: randomUUID(),
        claimedAt: new Date(NOW.getTime() - LEASE_MS),
        attempts: 1,
      },
    });

    const before = await readEvent();

    assert.equal(
      await claimProjectArchiveEvent(randomUUID(), NOW),
      null,
    );
    assert.deepEqual(await readEvent(), before);

    // The SQL uses "< staleBefore", so it becomes eligible
    // once the lease is strictly older than five minutes.
    const result = await claimProjectArchiveEvent(
      randomUUID(),
      new Date(NOW.getTime() + 1),
    );

    assert.equal(result?.id, eventId);
    assert.equal(result?.attempts, 2);
  });

  it('never claims an already completed event', async () => {
    await prisma.projectArchiveOutbox.update({
      where: { id: eventId },
      data: {
        processedAt: new Date(NOW.getTime() - 1_000),
      },
    });

    const before = await readEvent();

    assert.equal(
      await claimProjectArchiveEvent(randomUUID(), NOW),
      null,
    );
    assert.deepEqual(await readEvent(), before);
  });

  it('allows only one concurrent caller to claim the same event', async () => {
    const tokens = [randomUUID(), randomUUID()];

    const results = await Promise.all(
      tokens.map((token) => claimProjectArchiveEvent(token, NOW)),
    );

    assert.equal(
      results.filter((result) => result !== null).length,
      1,
    );

    const winnerIndex = results.findIndex(
      (result) => result !== null,
    );
    const winner = results[winnerIndex];

    assert.equal(winner?.id, eventId);
    assert.equal(winner?.attempts, 1);

    const event = await readEvent();

    assert.equal(event.claimToken, tokens[winnerIndex]);
    assert.equal(event.attempts, 1);
    assert.equal(event.claimedAt?.getTime(), NOW.getTime());
  });
});