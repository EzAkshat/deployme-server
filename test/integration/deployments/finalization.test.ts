import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';
import { DeploymentAccountSuspendedError } from '../../../src/services/deployment-account-guard.js';
import { prisma } from '../../../src/config/database.js';
import { finalizeDeployment } from '../../../src/services/deployment-finalization.js';
import { useTestData } from '../../support/test-data.js';

describe('deployment finalization', () => {
  const data = useTestData();

  async function fixture(t: TestContext) {
    const owner = await data.createUser({ prefix: 'finalize_owner' });

    const project = await prisma.project.create({
      data: {
        name: 'Finalization test project',
        slug: `finalize-project-${randomUUID()}`,
        ownerUserId: owner.id,
        teamId: null,
        rootDirectory: '.',
        installCommand: '',
        buildCommand: '',
        outputDirectory: '.',
        spaFallback: false,
      },
    });

    const deploymentIds: string[] = [];

    t.after(async () => {
      await prisma.deploymentOutbox.deleteMany({
        where: { deploymentId: { in: deploymentIds } },
      });

      await prisma.deployment.deleteMany({
        where: { projectId: project.id },
      });

      await prisma.project.deleteMany({
        where: { id: project.id },
      });

      await prisma.artifactUploadAttempt.deleteMany({
        where: { projectId: project.id },
      });
    });

    const processingToken = randomUUID();
    const startedAt = new Date();

    const deployment = await prisma.deployment.create({
      data: {
        projectId: project.id,
        commitSha: 'd'.repeat(40),
        status: 'BUILDING',
        processingToken,
        processingAttempt: 1,
        processingStartedAt: startedAt,
        buildStartedAt: startedAt,
      },
    });

    deploymentIds.push(deployment.id);

    // Metadata only: these tests upload no artifacts.
    const published = {
      artifactBucket: 'test-artifacts',
      artifactPrefix:
        `projects/${project.id}/deployments/` + `${deployment.id}/${processingToken}/`,
      fileCount: 2,
      totalFileBytes: 1234,
    };
    const uploadAttempt = await prisma.artifactUploadAttempt.create({
      data: {
        deploymentId: deployment.id,
        projectId: project.id,
        processingToken,
        artifactBucket: published.artifactBucket,
        artifactPrefix: published.artifactPrefix,
      },
    });

    function readAttempt() {
      return prisma.artifactUploadAttempt.findUniqueOrThrow({
        where: { id: uploadAttempt.id },
      });
    }
    const input = {
      deploymentId: deployment.id,
      projectId: project.id,
      processingToken,
      published,
    };

    function read() {
      return prisma.deployment.findUniqueOrThrow({
        where: { id: deployment.id },
      });
    }

    function events() {
      return prisma.deploymentOutbox.findMany({
        where: { deploymentId: deployment.id },
      });
    }

    return {
      owner,
      input,
      read,
      events,
      startedAt,
      readAttempt,
      attemptId: uploadAttempt.id,
    };
  }

  it('finalizes the current execution and creates one routing event', async (t) => {
    const f = await fixture(t);
    let lockChecks = 0;

    await finalizeDeployment({
      ...f.input,
      renewQueueLock: async () => {
        lockChecks += 1;
        return 1;
      },
    });

    const current = await f.read();
    const events = await f.events();
    const attempt = await f.readAttempt();

    assert.equal(attempt.status, 'ADOPTED');
    assert.ok(attempt.adoptedAt);
    assert.equal(attempt.adoptedAt.getTime(), current.publishedAt?.getTime());
    assert.equal(attempt.artifactPrefix, current.artifactPrefix);
    assert.equal(attempt.artifactBucket, current.artifactBucket);
    assert.equal(attempt.cleanupAfter, null);
    assert.equal(lockChecks, 1);
    assert.equal(current.status, 'READY');
    assert.equal(current.failureReason, null);
    assert.equal(current.processingToken, null);
    assert.equal(current.processingStartedAt, null);

    assert.equal(current.artifactBucket, f.input.published.artifactBucket);
    assert.equal(current.artifactPrefix, f.input.published.artifactPrefix);
    assert.equal(current.artifactFileCount, 2);
    assert.equal(current.artifactSizeBytes, 1234);

    assert.ok(current.publishedAt);
    assert.ok(current.buildFinishedAt);
    assert.equal(current.publishedAt.getTime(), current.buildFinishedAt.getTime());
    assert.equal(current.buildStartedAt?.getTime(), f.startedAt.getTime());

    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, 'DEPLOYMENT_ROUTING_REQUESTED');
    assert.deepEqual(events[0]?.payload, {
      deploymentId: f.input.deploymentId,
      projectId: f.input.projectId,
    });
  });

  it('rejects an obsolete token without changing the newer claim', async (t) => {
    const f = await fixture(t);
    const oldToken = f.input.processingToken;
    const newToken = randomUUID();

    await prisma.deployment.update({
      where: { id: f.input.deploymentId },
      data: {
        processingToken: newToken,
        processingAttempt: 2,
        processingStartedAt: new Date(),
      },
    });

    const before = await f.read();
    let lockChecks = 0;

    await assert.rejects(
      () =>
        finalizeDeployment({
          ...f.input,
          processingToken: oldToken,
          renewQueueLock: async () => {
            lockChecks += 1;
            return 1;
          },
        }),
      /processing ownership was lost/,
    );

    assert.equal(lockChecks, 0);
    assert.deepEqual(await f.read(), before);
    assert.equal((await f.events()).length, 0);
  });

  it('rolls back completion when queue ownership is lost or checking it throws', async (t) => {
    const f = await fixture(t);
    const before = await f.read();
    const attemptBefore = await f.readAttempt();
    const probes: Array<{
      run: () => Promise<number>;
      expected: RegExp;
    }> = [
      {
        run: async () => 0,
        expected: /queue ownership was lost/,
      },
      {
        run: async () => {
          throw new Error('Simulated Redis connection failure');
        },
        expected: /Simulated Redis connection failure/,
      },
    ];

    for (const probe of probes) {
      await assert.rejects(
        () =>
          finalizeDeployment({
            ...f.input,
            renewQueueLock: probe.run,
          }),
        probe.expected,
      );
      assert.deepEqual(await f.readAttempt(), attemptBefore);
      assert.deepEqual(await f.read(), before);
      assert.equal((await f.events()).length, 0);
    }
  });

  it('allows only one concurrent finalization and rejects a later repeat', async (t) => {
    const f = await fixture(t);

    const finish = () =>
      finalizeDeployment({
        ...f.input,
        renewQueueLock: async () => 1,
      });

    const results = await Promise.allSettled([finish(), finish()]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);

    const rejected = results.find((result) => result.status === 'rejected');

    assert.ok(rejected?.status === 'rejected');
    assert.match(String(rejected.reason), /processing ownership was lost/);

    const completed = await f.read();
    assert.equal(completed.status, 'READY');
    assert.equal((await f.events()).length, 1);

    await assert.rejects(finish, /processing ownership was lost/);

    assert.deepEqual(await f.read(), completed);
    assert.equal((await f.events()).length, 1);
  });
  it('rolls back finalization when the upload attempt is missing', async (t) => {
    const f = await fixture(t);
    const before = await f.read();

    await prisma.artifactUploadAttempt.delete({
      where: { id: f.attemptId },
    });

    await assert.rejects(
      () =>
        finalizeDeployment({
          ...f.input,
          renewQueueLock: async () => 1,
        }),
      /artifact upload attempt is missing or no longer eligible/,
    );

    assert.deepEqual(await f.read(), before);
    assert.equal((await f.events()).length, 0);
  });

  it('rejects a published prefix belonging to another execution', async (t) => {
    const f = await fixture(t);
    const before = await f.read();
    const attemptBefore = await f.readAttempt();
    let lockChecks = 0;

    await assert.rejects(
      () =>
        finalizeDeployment({
          ...f.input,
          published: {
            ...f.input.published,
            artifactPrefix:
              `projects/${f.input.projectId}/deployments/` +
              `${f.input.deploymentId}/${randomUUID()}/`,
          },
          renewQueueLock: async () => {
            lockChecks += 1;
            return 1;
          },
        }),
      /artifact prefix does not match this execution/,
    );

    assert.equal(lockChecks, 0);
    assert.deepEqual(await f.read(), before);
    assert.deepEqual(await f.readAttempt(), attemptBefore);
    assert.equal((await f.events()).length, 0);
  });

  it('rolls back finalization when the registered bucket does not match', async (t) => {
    const f = await fixture(t);
    const before = await f.read();
    const attemptBefore = await f.readAttempt();

    await assert.rejects(
      () =>
        finalizeDeployment({
          ...f.input,
          published: {
            ...f.input.published,
            artifactBucket: 'different-test-bucket',
          },
          renewQueueLock: async () => 1,
        }),
      /artifact upload attempt is missing or no longer eligible/,
    );

    assert.deepEqual(await f.read(), before);
    assert.deepEqual(await f.readAttempt(), attemptBefore);
    assert.equal((await f.events()).length, 0);
  });

  for (const status of ['CLEANUP_PENDING', 'CLEANED', 'ADOPTED'] as const) {
    it(`does not adopt an attempt already marked ${status}`, async (t) => {
      const f = await fixture(t);
      const before = await f.read();

      await prisma.artifactUploadAttempt.update({
        where: { id: f.attemptId },
        data: { status },
      });

      const attemptBefore = await f.readAttempt();

      await assert.rejects(
        () =>
          finalizeDeployment({
            ...f.input,
            renewQueueLock: async () => 1,
          }),
        /artifact upload attempt is missing or no longer eligible/,
      );

      assert.deepEqual(await f.read(), before);
      assert.deepEqual(await f.readAttempt(), attemptBefore);
      assert.equal((await f.events()).length, 0);
    });
  }

  it('does not adopt an upload attempt claimed for cleanup', async (t) => {
    const f = await fixture(t);
    const before = await f.read();

    await prisma.artifactUploadAttempt.update({
      where: { id: f.attemptId },
      data: {
        claimToken: randomUUID(),
        claimedAt: new Date(),
      },
    });

    const attemptBefore = await f.readAttempt();

    await assert.rejects(
      () =>
        finalizeDeployment({
          ...f.input,
          renewQueueLock: async () => 1,
        }),
      /artifact upload attempt is missing or no longer eligible/,
    );

    assert.deepEqual(await f.read(), before);
    assert.deepEqual(await f.readAttempt(), attemptBefore);
    assert.equal((await f.events()).length, 0);
  });
  it('rejects finalization for a suspended owner without adopting artifacts or creating a route event', async (t) => {
    const f = await fixture(t);

    await prisma.user.update({
      where: { id: f.owner.id },
      data: { suspendedAt: new Date() },
    });

    const deploymentBefore = await f.read();
    const attemptBefore = await f.readAttempt();
    let lockChecks = 0;

    await assert.rejects(
      () =>
        finalizeDeployment({
          ...f.input,
          renewQueueLock: async () => {
            lockChecks += 1;
            return 1;
          },
        }),
      (error: unknown) => error instanceof DeploymentAccountSuspendedError,
    );

    assert.equal(lockChecks, 0);
    assert.deepEqual(await f.read(), deploymentBefore);
    assert.deepEqual(await f.readAttempt(), attemptBefore);
    assert.equal((await f.events()).length, 0);
  });
});
