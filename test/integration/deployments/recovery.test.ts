import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';

import { prisma } from '../../../src/config/database.js';
import {
  reconcileDeploymentQueueItem,
  type RecoveryQueueJob,
} from '../../../src/services/deployment-recovery-item.js';
import { useTestData } from '../../support/test-data.js';

const COMMIT_SHA = 'e'.repeat(40);

// Passed explicitly so this test never imports the live queue.
const POLICY = {
  maxDispatchAttempts: 10,
  claimLeaseMs: 60_000,
};

describe('deployment recovery decisions', () => {
  const data = useTestData();

  async function fixture(t: TestContext, old = false) {
    const owner = await data.createUser({ prefix: 'recovery_owner' });

    const project = await prisma.project.create({
      data: {
        name: 'Recovery test project',
        slug: `recovery-project-${randomUUID()}`,
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

    const timestamp = new Date(
      Date.now() - (old ? 20 * 60 * 1_000 : 0),
    );

    const deployment = await prisma.deployment.create({
      data: {
        projectId: project.id,
        commitSha: COMMIT_SHA,
        status: 'PENDING',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });

    deploymentIds.push(deployment.id);

    const event = await prisma.deploymentOutbox.create({
      data: {
        deploymentId: deployment.id,
        eventType: 'DEPLOYMENT_REQUESTED',
        createdAt: timestamp,
        processedAt: timestamp,
        payload: {
          deploymentId: deployment.id,
          projectId: project.id,
          commitSha: COMMIT_SHA,
        },
      },
    });

    const jobId = `outbox-${event.id}`;

    function job(state: string, attemptsStarted = 1): RecoveryQueueJob {
      return {
        name: 'DEPLOYMENT_REQUESTED',
        attemptsStarted,
        data: {
          outboxEventId: event.id,
          deploymentId: deployment.id,
          projectId: project.id,
          commitSha: COMMIT_SHA,
        },
        getState: async () => state,
      };
    }

    function run(
      getJob: (
        id: string,
      ) => Promise<RecoveryQueueJob | null | undefined>,
    ) {
      return reconcileDeploymentQueueItem(deployment.id, {
        ...POLICY,
        getJob: async (id) => {
          assert.equal(id, jobId);
          return getJob(id);
        },
      });
    }

    function read() {
      return prisma.deployment.findUniqueOrThrow({
        where: { id: deployment.id },
      });
    }

    return { deployment, event, jobId, timestamp, job, run, read };
  }

  for (const state of ['active', 'waiting', 'delayed']) {
    it(`leaves a verified ${state} job unchanged`, async (t) => {
      const f = await fixture(t);

      await prisma.deployment.update({
        where: { id: f.deployment.id },
        data: {
          status: 'BUILDING',
          processingJobId: f.jobId,
          processingAttempt: 1,
          processingToken: randomUUID(),
          processingStartedAt: new Date(),
        },
      });

      const before = await f.read();

      assert.equal(await f.run(async () => f.job(state)), false);
      assert.deepEqual(await f.read(), before);
    });
  }

  it('preserves a recently dispatched deployment when its job is missing', async (t) => {
    const f = await fixture(t);
    const before = await f.read();
    let lookups = 0;

    assert.equal(
      await f.run(async () => {
        lookups += 1;
        return undefined;
      }),
      false,
    );

    assert.equal(lookups, 1);
    assert.deepEqual(await f.read(), before);
  });

  it('fails an old acknowledged dispatch only after confirming the job is still missing', async (t) => {
    const f = await fixture(t, true);
    let lookups = 0;

    assert.equal(
      await f.run(async () => {
        lookups += 1;
        return undefined;
      }),
      true,
    );

    const current = await f.read();

    assert.equal(lookups, 2);
    assert.equal(current.status, 'FAILED');
    assert.equal(
      current.failureReason,
      'Deployment queue job is missing after dispatch. Request a new deployment.',
    );
    assert.equal(current.processingToken, null);
    assert.ok(current.buildFinishedAt);
  });

  it('fails an old exhausted dispatch with the dispatch-specific reason', async (t) => {
    const f = await fixture(t, true);

    await prisma.deploymentOutbox.update({
      where: { id: f.event.id },
      data: {
        processedAt: null,
        attempts: POLICY.maxDispatchAttempts,
        claimToken: null,
        claimedAt: null,
      },
    });

    assert.equal(await f.run(async () => undefined), true);

    const current = await f.read();

    assert.equal(current.status, 'FAILED');
    assert.equal(
      current.failureReason,
      'Deployment could not be queued after repeated dispatch attempts. Request a new deployment.',
    );
    assert.ok(current.buildFinishedAt);
  });

  it('does not interpret a Redis error on either lookup as a missing job', async (t) => {
    const f = await fixture(t, true);
    const before = await f.read();

    for (const failOnLookup of [1, 2]) {
      let lookups = 0;

      await assert.rejects(
        () =>
          f.run(async () => {
            lookups += 1;

            if (lookups === failOnLookup) {
              throw new Error('Simulated Redis outage');
            }

            return undefined;
          }),
        /Simulated Redis outage/,
      );

      assert.equal(lookups, failOnLookup);
      assert.deepEqual(await f.read(), before);
    }
  });

  it('ignores a failed queue execution older than the database claim', async (t) => {
    const f = await fixture(t);

    await prisma.deployment.update({
      where: { id: f.deployment.id },
      data: {
        status: 'BUILDING',
        processingJobId: f.jobId,
        processingAttempt: 2,
        processingToken: randomUUID(),
        processingStartedAt: new Date(),
      },
    });

    const before = await f.read();

    assert.equal(await f.run(async () => f.job('failed', 1)), false);
    assert.deepEqual(await f.read(), before);
  });
});