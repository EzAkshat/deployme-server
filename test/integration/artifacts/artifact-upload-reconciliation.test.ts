import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { prisma } from '../../../src/config/database.js';
import { r2BucketName } from '../../../src/config/r2.js';
import { createArtifactPrefix } from '../../../src/services/artifact-object.js';
import { reconcileArtifactUploadAttempts } from '../../../src/services/artifact-upload-reconciliation.js';

describe('artifact upload reconciliation', () => {
  let ownerId: number;
  let projectId: string;
  let deploymentId: string;
  let attemptId: string;
  let processingToken: string;
  let artifactPrefix: string;

  beforeEach(async () => {
    const suffix = randomUUID().replaceAll('-', '');
    processingToken = randomUUID();

    const owner = await prisma.user.create({
      data: {
        email: `artifact-reconcile-${suffix}@example.com`,
        username: `arc_${suffix.slice(0, 16)}`,
        name: 'Artifact Reconciliation Test',
      },
    });
    ownerId = owner.id;

    const project = await prisma.project.create({
      data: {
        ownerUserId: ownerId,
        name: 'Artifact Reconciliation Test',
        slug: `arc-${suffix}`,
      },
    });
    projectId = project.id;

    const deployment = await prisma.deployment.create({
      data: {
        projectId,
        status: 'BUILDING',
        processingToken,
        commitSha: 'a'.repeat(40),
      },
    });
    deploymentId = deployment.id;

    artifactPrefix = createArtifactPrefix(projectId, deploymentId, processingToken);

    const attempt = await prisma.artifactUploadAttempt.create({
      data: {
        projectId,
        deploymentId,
        processingToken,
        artifactBucket: r2BucketName,
        artifactPrefix,
      },
    });
    attemptId = attempt.id;
  });

  afterEach(async () => {
    await prisma.artifactUploadAttempt.deleteMany({
      where: { projectId },
    });
    await prisma.project.deleteMany({
      where: { id: projectId },
    });
    await prisma.user.deleteMany({
      where: { id: ownerId },
    });
  });

  after(async () => {
    await prisma.$disconnect();
  });

  function readAttempt() {
    return prisma.artifactUploadAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
  }

  it('preserves an old upload while its execution still owns the deployment', async () => {
    await prisma.artifactUploadAttempt.update({
      where: { id: attemptId },
      data: { createdAt: new Date(Date.now() - 24 * 60 * 60_000) },
    });

    await reconcileArtifactUploadAttempts();

    const attempt = await readAttempt();
    assert.equal(attempt.status, 'UPLOADING');
    assert.equal(attempt.cleanupAfter, null);
  });

  it('schedules a replaced execution with a cleanup delay', async () => {
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { processingToken: randomUUID() },
    });

    const startedAt = Date.now();
    await reconcileArtifactUploadAttempts();

    const attempt = await readAttempt();
    assert.equal(attempt.status, 'CLEANUP_PENDING');
    assert.ok(attempt.cleanupAfter);
    assert.ok(attempt.cleanupAfter.getTime() >= startedAt + 15 * 60_000);
    assert.equal(attempt.claimToken, null);
    assert.equal(attempt.cleanedAt, null);
  });

  for (const status of ['READY', 'FAILED', 'CANCELLED'] as const) {
    it(`schedules an unreferenced upload for a ${status} deployment`, async () => {
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { status, processingToken: null },
      });

      await reconcileArtifactUploadAttempts();

      const attempt = await readAttempt();
      assert.equal(attempt.status, 'CLEANUP_PENDING');
      assert.ok(attempt.cleanupAfter);
    });
  }

  it('preserves artifacts referenced by a deployment', async () => {
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: 'READY',
        processingToken: null,
        artifactBucket: r2BucketName,
        artifactPrefix,
      },
    });

    await reconcileArtifactUploadAttempts();

    assert.equal((await readAttempt()).status, 'UPLOADING');
  });

  it('leaves adopted attempts unchanged', async () => {
    await prisma.artifactUploadAttempt.update({
      where: { id: attemptId },
      data: { status: 'ADOPTED', adoptedAt: new Date() },
    });

    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: 'FAILED', processingToken: null },
    });

    await reconcileArtifactUploadAttempts();

    const attempt = await readAttempt();
    assert.equal(attempt.status, 'ADOPTED');
    assert.equal(attempt.cleanupAfter, null);
  });

  it('preserves an attempt when its deployment is missing', async () => {
    await prisma.deployment.delete({
      where: { id: deploymentId },
    });

    await reconcileArtifactUploadAttempts();

    assert.equal((await readAttempt()).status, 'UPLOADING');
  });

  it('does not reschedule an attempt already pending cleanup', async () => {
    const cleanupAfter = new Date(Date.now() + 60_000);

    await prisma.artifactUploadAttempt.update({
      where: { id: attemptId },
      data: { status: 'CLEANUP_PENDING', cleanupAfter },
    });

    await reconcileArtifactUploadAttempts();

    const attempt = await readAttempt();
    assert.equal(attempt.status, 'CLEANUP_PENDING');
    assert.equal(attempt.cleanupAfter?.getTime(), cleanupAfter.getTime());
  });
});
