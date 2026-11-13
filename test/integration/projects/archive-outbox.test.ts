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
  processClaimedProjectArchiveEvent,
} from '../../../src/services/project-archive-outbox.js';

describe('archive outbox completion and retries', () => {
  let ownerId: number | undefined;
  let projectId: string;
  let eventId: string;
  let claimToken: string;

  beforeEach(async () => {
    const suffix = randomUUID().replaceAll('-', '');

    const owner = await prisma.user.create({
      data: {
        email: `archive-outbox-${suffix}@example.com`,
        username: `ao_${suffix.slice(0, 16)}`,
        name: 'Archive Outbox Test',
      },
    });
    ownerId = owner.id;

    const project = await prisma.project.create({
      data: {
        ownerUserId: owner.id,
        name: 'Archive Outbox Test',
        slug: `ao-${suffix}`,
        archivedAt: new Date(),
      },
    });
    projectId = project.id;
    claimToken = randomUUID();

    const event = await prisma.projectArchiveOutbox.create({
      data: {
        projectId,
        attempts: 1,
        claimToken,
        claimedAt: new Date(),
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

  function claimedEvent(attempts = 1) {
    return { id: eventId, projectId, attempts };
  }

  function readEvent() {
    return prisma.projectArchiveOutbox.findUniqueOrThrow({
      where: { id: eventId },
    });
  }

  it('acknowledges successful shutdown and clears claim and error fields', async () => {
    await prisma.projectArchiveOutbox.update({
      where: { id: eventId },
      data: { lastError: 'Earlier failure' },
    });

    let calls = 0;

    const result = await processClaimedProjectArchiveEvent(
      claimedEvent(),
      claimToken,
      async (receivedProjectId) => {
        calls += 1;
        assert.equal(receivedProjectId, projectId);
        return 'disabled';
      },
    );

    const event = await readEvent();

    assert.equal(result, 1);
    assert.equal(calls, 1);
    assert.ok(event.processedAt instanceof Date);
    assert.equal(event.claimToken, null);
    assert.equal(event.claimedAt, null);
    assert.equal(event.lastError, null);
    assert.equal(event.attempts, 1);
  });

  it('schedules a failed first attempt for retry after 30 seconds', async () => {
    const failure = new Error('Simulated storage outage');
    const before = Date.now();

    await assert.rejects(
      processClaimedProjectArchiveEvent(
        claimedEvent(),
        claimToken,
        async () => {
          throw failure;
        },
      ),
      (error: unknown) => error === failure,
    );

    const after = Date.now();
    const event = await readEvent();

    assert.equal(event.processedAt, null);
    assert.equal(event.claimToken, null);
    assert.equal(event.claimedAt, null);
    assert.equal(event.lastError, failure.message);
    assert.equal(event.attempts, 1);
    assert.ok(event.nextAttemptAt.getTime() >= before + 30_000);
    assert.ok(event.nextAttemptAt.getTime() <= after + 30_000);
  });

  it('caps retry delay at five minutes and truncates the saved error', async () => {
    await prisma.projectArchiveOutbox.update({
      where: { id: eventId },
      data: { attempts: 20 },
    });

    const message = 'x'.repeat(2_500);
    const before = Date.now();

    await assert.rejects(
      processClaimedProjectArchiveEvent(
        claimedEvent(20),
        claimToken,
        async () => {
          throw new Error(message);
        },
      ),
      (error: unknown) =>
        error instanceof Error && error.message === message,
    );

    const after = Date.now();
    const event = await readEvent();

    assert.equal(event.processedAt, null);
    assert.equal(event.lastError, message.slice(0, 2_000));
    assert.ok(event.nextAttemptAt.getTime() >= before + 300_000);
    assert.ok(event.nextAttemptAt.getTime() <= after + 300_000);
  });

  it('does not acknowledge success after another worker replaces the claim', async () => {
    const replacementToken = randomUUID();
    let replacement:
      Awaited<ReturnType<typeof readEvent>> | undefined;

    const result = await processClaimedProjectArchiveEvent(
      claimedEvent(),
      claimToken,
      async () => {
        replacement = await prisma.projectArchiveOutbox.update({
          where: { id: eventId },
          data: {
            claimToken: replacementToken,
            claimedAt: new Date(),
            attempts: 2,
          },
        });

        return 'disabled';
      },
    );

    assert.equal(result, 0);
    assert.deepEqual(await readEvent(), replacement);
  });

  it('does not overwrite a newer claim when an old worker fails', async () => {
    const failure = new Error('Old worker failed');
    let replacement:
      Awaited<ReturnType<typeof readEvent>> | undefined;

    await assert.rejects(
      processClaimedProjectArchiveEvent(
        claimedEvent(),
        claimToken,
        async () => {
          replacement = await prisma.projectArchiveOutbox.update({
            where: { id: eventId },
            data: {
              claimToken: randomUUID(),
              claimedAt: new Date(),
              attempts: 2,
              lastError: 'Preserve newer worker state',
            },
          });

          throw failure;
        },
      ),
      (error: unknown) => error === failure,
    );

    assert.deepEqual(await readEvent(), replacement);
  });

  it('completes an event after a failed attempt is claimed again', async () => {
    await assert.rejects(
      processClaimedProjectArchiveEvent(
        claimedEvent(),
        claimToken,
        async () => {
          throw new Error('Temporary failure');
        },
      ),
      /Temporary failure/,
    );

    const retryToken = randomUUID();

    await prisma.projectArchiveOutbox.update({
      where: { id: eventId },
      data: {
        claimToken: retryToken,
        claimedAt: new Date(),
        attempts: 2,
      },
    });

    const result = await processClaimedProjectArchiveEvent(
      claimedEvent(2),
      retryToken,
      async () => 'unchanged',
    );

    const event = await readEvent();

    assert.equal(result, 1);
    assert.ok(event.processedAt instanceof Date);
    assert.equal(event.attempts, 2);
    assert.equal(event.lastError, null);
    assert.equal(event.claimToken, null);
    assert.equal(event.claimedAt, null);
  });
});