import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { prisma } from '../../../src/config/database.js';
import { archiveProject } from '../../../src/services/project-archive.js';
import { ProjectAuthorizationError } from '../../../src/services/project-authorization.js';

describe('project archive requests', () => {
  after(async () => {
    await prisma.$disconnect();
  });

  async function createFixture() {
    const suffix = randomUUID().replaceAll('-', '');

    const owner = await prisma.user.create({
      data: {
        email: `archive-${suffix}@example.com`,
        username: `archive_${suffix.slice(0, 16)}`,
        name: 'Archive Test',
      },
    });

    try {
      const project = await prisma.project.create({
        data: {
          ownerUserId: owner.id,
          name: 'Archive Test Project',
          slug: `archive-${suffix}`,
        },
      });

      return {
        owner,
        project,
        async cleanup() {
          // Deleting the project also removes its archive outbox event.
          await prisma.project.deleteMany({
            where: { id: project.id },
          });
          await prisma.user.deleteMany({
            where: { id: owner.id },
          });
        },
      };
    } catch (error) {
      await prisma.user.delete({ where: { id: owner.id } });
      throw error;
    }
  }

  it('archives a personal project and creates a pending shutdown event', async (t) => {
    const fixture = await createFixture();
    t.after(() => fixture.cleanup());

    const result = await archiveProject(
      fixture.owner.id,
      fixture.project.id,
    );

    assert.equal(result.alreadyArchived, false);
    assert.equal(result.deliveryDisableStatus, 'pending');

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: fixture.project.id },
    });
    const event = await prisma.projectArchiveOutbox.findUniqueOrThrow({
      where: { projectId: fixture.project.id },
    });

    assert.ok(project.archivedAt instanceof Date);
    assert.equal(
      project.archivedAt.getTime(),
      result.project.archivedAt.getTime(),
    );
    assert.equal(event.processedAt, null);
    assert.equal(event.attempts, 0);
    assert.equal(event.claimToken, null);
  });

  it('creates one event for concurrent and repeated archive requests', async (t) => {
    const fixture = await createFixture();
    t.after(() => fixture.cleanup());

    const results = await Promise.all([
      archiveProject(fixture.owner.id, fixture.project.id),
      archiveProject(fixture.owner.id, fixture.project.id),
    ]);

    assert.equal(
      results.filter((result) => !result.alreadyArchived).length,
      1,
    );
    assert.equal(
      results[0]!.project.archivedAt.getTime(),
      results[1]!.project.archivedAt.getTime(),
    );

    const repeated = await archiveProject(
      fixture.owner.id,
      fixture.project.id,
    );

    assert.equal(repeated.alreadyArchived, true);
    assert.equal(
      repeated.project.archivedAt.getTime(),
      results[0]!.project.archivedAt.getTime(),
    );
    assert.equal(
      await prisma.projectArchiveOutbox.count({
        where: { projectId: fixture.project.id },
      }),
      1,
    );
  });

  it('preserves a completed shutdown when archiving again', async (t) => {
    const fixture = await createFixture();
    t.after(() => fixture.cleanup());

    const first = await archiveProject(
      fixture.owner.id,
      fixture.project.id,
    );
    const processedAt = new Date();

    const originalEvent = await prisma.projectArchiveOutbox.update({
      where: { projectId: fixture.project.id },
      data: { processedAt },
    });

    const repeated = await archiveProject(
      fixture.owner.id,
      fixture.project.id,
    );
    const event = await prisma.projectArchiveOutbox.findUniqueOrThrow({
      where: { projectId: fixture.project.id },
    });

    assert.equal(repeated.alreadyArchived, true);
    assert.equal(repeated.deliveryDisableStatus, 'completed');
    assert.equal(
      repeated.project.archivedAt.getTime(),
      first.project.archivedAt.getTime(),
    );
    assert.equal(event.id, originalEvent.id);
    assert.equal(event.processedAt?.getTime(), processedAt.getTime());
  });

  it('rejects another user without archiving or creating an event', async (t) => {
    const ownerFixture = await createFixture();
    t.after(() => ownerFixture.cleanup());

    const otherFixture = await createFixture();
    t.after(() => otherFixture.cleanup());

    await assert.rejects(
      archiveProject(otherFixture.owner.id, ownerFixture.project.id),
      (error: unknown) =>
        error instanceof ProjectAuthorizationError &&
        error.code === 'PROJECT_ACCESS_DENIED',
    );

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: ownerFixture.project.id },
    });

    assert.equal(project.archivedAt, null);
    assert.equal(
      await prisma.projectArchiveOutbox.count({
        where: { projectId: ownerFixture.project.id },
      }),
      0,
    );
  });

  it('rejects a missing project', async () => {
    await assert.rejects(
      archiveProject(0, `missing-${randomUUID()}`),
      (error: unknown) =>
        error instanceof ProjectAuthorizationError &&
        error.code === 'PROJECT_ACCESS_DENIED',
    );
  });
});