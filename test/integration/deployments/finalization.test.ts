import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';

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
        `projects/${project.id}/deployments/` +
        `${deployment.id}/${processingToken}/`,
      fileCount: 2,
      totalFileBytes: 1234,
    };

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

    return { input, read, events, startedAt };
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

    assert.equal(lockChecks, 1);
    assert.equal(current.status, 'READY');
    assert.equal(current.failureReason, null);
    assert.equal(current.processingToken, null);
    assert.equal(current.processingStartedAt, null);

    assert.equal(
      current.artifactBucket,
      f.input.published.artifactBucket,
    );
    assert.equal(
      current.artifactPrefix,
      f.input.published.artifactPrefix,
    );
    assert.equal(current.artifactFileCount, 2);
    assert.equal(current.artifactSizeBytes, 1234);

    assert.ok(current.publishedAt);
    assert.ok(current.buildFinishedAt);
    assert.equal(
      current.publishedAt.getTime(),
      current.buildFinishedAt.getTime(),
    );
    assert.equal(
      current.buildStartedAt?.getTime(),
      f.startedAt.getTime(),
    );

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

    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );

    const rejected = results.find(
      (result) => result.status === 'rejected',
    );

    assert.ok(rejected?.status === 'rejected');
    assert.match(
      String(rejected.reason),
      /processing ownership was lost/,
    );

    const completed = await f.read();
    assert.equal(completed.status, 'READY');
    assert.equal((await f.events()).length, 1);

    await assert.rejects(finish, /processing ownership was lost/);

    assert.deepEqual(await f.read(), completed);
    assert.equal((await f.events()).length, 1);
  });
});