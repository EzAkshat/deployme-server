import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { prisma } from '../../../src/config/database.js';
import { r2BucketName } from '../../../src/config/r2.js';
import {
  processArtifactUploadCleanup,
  type ArtifactCleanupStorage,
} from '../../../src/services/artifact-upload-cleanup.js';

describe('abandoned artifact upload cleanup', () => {
  let ownerId: number | undefined;
  let projectId: string;
  let deploymentId: string;
  let attemptId: string;
  let processingToken: string;
  let prefix: string;

  beforeEach(async () => {
    const suffix = randomUUID().replaceAll('-', '');

    const owner = await prisma.user.create({
      data: {
        email: `artifact-cleanup-${suffix}@example.com`,
        username: `ac_${suffix.slice(0, 16)}`,
        name: 'Artifact Cleanup Test',
      },
    });
    ownerId = owner.id;

    const project = await prisma.project.create({
      data: {
        ownerUserId: owner.id,
        name: 'Artifact Cleanup Test',
        slug: `ac-${suffix}`,
        subdomain: `ac-${suffix}`,
      },
    });

    projectId = project.id;
    processingToken = randomUUID();

    const deployment = await prisma.deployment.create({
      data: {
        projectId,
        commitSha: 'a'.repeat(40),
        status: 'FAILED',
        processingToken: null,
      },
    });

    deploymentId = deployment.id;
    prefix = `projects/${projectId}/deployments/` + `${deploymentId}/${processingToken}/`;

    const attempt = await prisma.artifactUploadAttempt.create({
      data: {
        projectId,
        deploymentId,
        processingToken,
        artifactBucket: r2BucketName,
        artifactPrefix: prefix,
        status: 'CLEANUP_PENDING',
        cleanupAfter: new Date(Date.now() - 60_000),
      },
    });

    attemptId = attempt.id;
  });

  afterEach(async () => {
    if (ownerId === undefined) return;

    const projects = await prisma.project.findMany({
      where: { ownerUserId: ownerId },
      select: { id: true },
    });

    await prisma.artifactUploadAttempt.deleteMany({
      where: {
        projectId: { in: projects.map((project) => project.id) },
      },
    });

    await prisma.project.deleteMany({
      where: { ownerUserId: ownerId },
    });

    await prisma.user.deleteMany({
      where: { id: ownerId },
    });

    ownerId = undefined;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  function readAttempt() {
    return prisma.artifactUploadAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
  }

  async function makeDue() {
    await prisma.artifactUploadAttempt.update({
      where: { id: attemptId },
      data: { cleanupAfter: new Date(Date.now() - 1_000) },
    });
  }

  function fakeStorage(initialKeys: string[] = []) {
    const keys = new Set(initialKeys);

    const calls = {
      reads: 0,
      lists: 0,
      deletes: [] as string[][],
    };

    const storage: ArtifactCleanupStorage = {
      async readDeliveryRoute() {
        calls.reads += 1;
        return null;
      },

      async listObjects(bucket, requestedPrefix, limit) {
        calls.lists += 1;

        assert.equal(bucket, r2BucketName);
        assert.equal(requestedPrefix, prefix);
        assert.equal(limit, 1_000);

        return {
          Contents: [...keys].map((Key) => ({ Key })),
          IsTruncated: false,
        };
      },

      async deleteObjects(bucket, requestedKeys) {
        assert.equal(bucket, r2BucketName);
        calls.deletes.push([...requestedKeys]);

        for (const key of requestedKeys) {
          keys.delete(key);
        }

        return {};
      },
    };

    return { storage, calls, keys };
  }

  function run(storage: ArtifactCleanupStorage) {
    return processArtifactUploadCleanup({ attemptId, storage });
  }

  for (const status of ['UPLOADING', 'ADOPTED'] as const) {
    it(`does not select ${status} attempts`, async () => {
      await prisma.artifactUploadAttempt.update({
        where: { id: attemptId },
        data: { status },
      });

      const before = await readAttempt();
      const f = fakeStorage([`${prefix}index.html`]);

      assert.equal(await run(f.storage), 0);
      assert.deepEqual(await readAttempt(), before);
      assert.equal(f.calls.reads, 0);
      assert.equal(f.calls.lists, 0);
      assert.equal(f.calls.deletes.length, 0);
    });
  }

  it('protects an execution that still owns the deployment', async () => {
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: 'BUILDING',
        processingToken,
      },
    });

    const f = fakeStorage([`${prefix}index.html`]);

    assert.equal(await run(f.storage), 0);
    assert.equal(f.calls.lists, 0);
    assert.equal(f.calls.deletes.length, 0);
    assert.match((await readAttempt()).lastError ?? '', /still owns the deployment/);
  });

  it('protects a prefix referenced by a deployment', async () => {
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        artifactBucket: r2BucketName,
        artifactPrefix: prefix,
      },
    });

    const f = fakeStorage([`${prefix}index.html`]);

    assert.equal(await run(f.storage), 0);
    assert.equal(f.calls.lists, 0);
    assert.equal(f.calls.deletes.length, 0);
  });

  it('protects a publicly routed prefix', async () => {
    const f = fakeStorage([`${prefix}index.html`]);

    f.storage.readDeliveryRoute = async () => ({
      etag: '"live"',
      record: {
        version: 1,
        projectId,
        artifactPrefix: prefix,
      },
    });

    assert.equal(await run(f.storage), 0);
    assert.equal(f.calls.lists, 0);
    assert.equal(f.calls.deletes.length, 0);
    assert.match((await readAttempt()).lastError ?? '', /publicly routed/);
  });

  it('refuses deletion when route lookup fails', async () => {
    const f = fakeStorage([`${prefix}index.html`]);

    f.storage.readDeliveryRoute = async () => {
      throw new Error('Simulated route read failure');
    };

    assert.equal(await run(f.storage), 0);
    assert.equal(f.calls.deletes.length, 0);

    const attempt = await readAttempt();
    assert.equal(attempt.claimToken, null);
    assert.ok(attempt.cleanupAfter);
    assert.match(attempt.lastError ?? '', /Simulated route read failure/);
  });

  it('refuses deletion for an invalid route record', async () => {
    const f = fakeStorage([`${prefix}index.html`]);

    f.storage.readDeliveryRoute = async () => ({
      etag: '"invalid"',
      record: { version: 99 },
    });

    assert.equal(await run(f.storage), 0);
    assert.equal(f.calls.deletes.length, 0);
    assert.match((await readAttempt()).lastError ?? '', /invalid delivery route/);
  });

  it('rejects keys outside the exact attempt prefix', async () => {
    const f = fakeStorage(['projects/another-project/index.html']);

    assert.equal(await run(f.storage), 0);
    assert.equal(f.calls.deletes.length, 0);
    assert.match((await readAttempt()).lastError ?? '', /unexpected object key/);
  });

  it('deletes a page, then requires an empty observation before marking CLEANED', async () => {
    const expected = [`${prefix}index.html`, `${prefix}assets/app.js`];
    const f = fakeStorage(expected);

    assert.equal(await run(f.storage), 1);
    assert.deepEqual(f.calls.deletes, [expected]);

    let attempt = await readAttempt();
    assert.equal(attempt.status, 'CLEANUP_PENDING');
    assert.equal(attempt.cleanedAt, null);
    assert.equal(attempt.claimToken, null);

    await makeDue();

    assert.equal(await run(f.storage), 1);

    attempt = await readAttempt();
    assert.equal(attempt.status, 'CLEANED');
    assert.ok(attempt.cleanedAt);
    assert.ok(attempt.cleanupAfter);
    assert.ok(attempt.cleanupAfter.getTime() > Date.now() + 23 * 60 * 60_000);
    assert.equal(f.calls.deletes.length, 1);
  });

  it('revisits a cleaned prefix and removes a late object', async () => {
    const f = fakeStorage();

    assert.equal(await run(f.storage), 1);
    assert.equal((await readAttempt()).status, 'CLEANED');

    f.keys.add(`${prefix}late.html`);
    await makeDue();

    assert.equal(await run(f.storage), 1);
    assert.deepEqual(f.calls.deletes, [[`${prefix}late.html`]]);
    assert.equal((await readAttempt()).status, 'CLEANUP_PENDING');
  });

  it('persists a retry after a partial deletion error', async () => {
    const f = fakeStorage([`${prefix}index.html`]);

    f.storage.deleteObjects = async () => ({
      Errors: [
        {
          Key: `${prefix}index.html`,
          Code: 'InternalError',
        },
      ],
    });

    assert.equal(await run(f.storage), 0);

    const attempt = await readAttempt();
    assert.equal(attempt.status, 'CLEANUP_PENDING');
    assert.equal(attempt.claimToken, null);
    assert.equal(attempt.claimedAt, null);
    assert.equal(attempt.cleanupAttempts, 1);
    assert.ok(attempt.cleanupAfter);
    assert.ok(attempt.cleanupAfter.getTime() > Date.now());
    assert.match(attempt.lastError ?? '', /failed to delete 1/);

    // Retry succeeds once storage recovers.
    f.storage.deleteObjects = async (_bucket, keys) => {
      for (const key of keys) f.keys.delete(key);
      return {};
    };

    await makeDue();
    assert.equal(await run(f.storage), 1);
    assert.equal((await readAttempt()).cleanupAttempts, 2);
  });

  it('leaves an unexpired cleanup claim untouched', async () => {
    await prisma.artifactUploadAttempt.update({
      where: { id: attemptId },
      data: {
        claimToken: randomUUID(),
        claimedAt: new Date(),
      },
    });

    const before = await readAttempt();
    const f = fakeStorage();

    assert.equal(await run(f.storage), 0);
    assert.deepEqual(await readAttempt(), before);
    assert.equal(f.calls.lists, 0);
  });

  it('reclaims an expired cleanup claim', async () => {
    await prisma.artifactUploadAttempt.update({
      where: { id: attemptId },
      data: {
        claimToken: randomUUID(),
        claimedAt: new Date(Date.now() - 6 * 60_000),
      },
    });

    const f = fakeStorage();

    assert.equal(await run(f.storage), 1);
    assert.equal((await readAttempt()).status, 'CLEANED');
    assert.equal((await readAttempt()).claimToken, null);
  });

  it('rechecks the public route after listing and before deletion', async () => {
    const f = fakeStorage([`${prefix}index.html`]);
    let reads = 0;

    f.storage.readDeliveryRoute = async () => {
      reads += 1;

      return reads === 1
        ? null
        : {
            etag: '"now-live"',
            record: {
              version: 1,
              projectId,
              artifactPrefix: prefix,
            },
          };
    };

    assert.equal(await run(f.storage), 0);
    assert.equal(f.calls.lists, 1);
    assert.equal(f.calls.deletes.length, 0);
  });

  it('does not delete after its cleanup claim is replaced', async () => {
    const f = fakeStorage([`${prefix}index.html`]);
    const replacementToken = randomUUID();

    f.storage.listObjects = async () => {
      await prisma.artifactUploadAttempt.update({
        where: { id: attemptId },
        data: {
          claimToken: replacementToken,
          claimedAt: new Date(),
        },
      });

      return {
        Contents: [{ Key: `${prefix}index.html` }],
        IsTruncated: false,
      };
    };

    assert.equal(await run(f.storage), 0);
    assert.equal(f.calls.deletes.length, 0);
    assert.equal((await readAttempt()).claimToken, replacementToken);
  });
});
