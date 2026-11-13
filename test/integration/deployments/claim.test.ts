import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';

import { prisma } from '../../../src/config/database.js';
import {
  claimDeploymentExecution,
  DEPLOYMENT_LOCK_DURATION_MS,
} from '../../../src/services/deployment-claim.js';
import { useTestData } from '../../support/test-data.js';

type ClaimJob = Parameters<typeof claimDeploymentExecution>[0];

const COMMIT_SHA = 'b'.repeat(40);
const QUEUE_TOKEN = 'test-queue-token';

describe('deployment execution claims', () => {
  const data = useTestData();

  async function fixture(t: TestContext) {
    const owner = await data.createUser({ prefix: 'claim_owner' });

    const project = await prisma.project.create({
      data: {
        name: 'Claim test project',
        slug: `claim-project-${randomUUID()}`,
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

    const deployment = await prisma.deployment.create({
      data: {
        projectId: project.id,
        commitSha: COMMIT_SHA,
        status: 'PENDING',
      },
    });

    deploymentIds.push(deployment.id);

    const event = await prisma.deploymentOutbox.create({
      data: {
        deploymentId: deployment.id,
        eventType: 'DEPLOYMENT_REQUESTED',
        payload: {
          deploymentId: deployment.id,
          projectId: project.id,
          commitSha: COMMIT_SHA,
        },

        // Prevent the dispatcher from enqueueing this test fixture.
        processedAt: new Date(),
      },
    });

    function job(attempt: number, lockResults: number[] = [1, 1]) {
      let calls = 0;

      const fake = {
        id: `outbox-${event.id}`,
        data: {
          deploymentId: deployment.id,
          projectId: project.id,
          commitSha: COMMIT_SHA,
          outboxEventId: event.id,
        },
        attemptsStarted: attempt,
        async extendLock(token: string, duration: number) {
          assert.equal(token, QUEUE_TOKEN);
          assert.equal(duration, DEPLOYMENT_LOCK_DURATION_MS);

          const result = lockResults[calls];
          calls += 1;

          assert.notEqual(
            result,
            undefined,
            'Unexpected extra queue-lock check.',
          );

          return result!;
        },
      };

      // Only the Job members used by the claim service are simulated.
      return {
        value: fake as unknown as ClaimJob,
        lockChecks: () => calls,
      };
    }

    function read() {
      return prisma.deployment.findUniqueOrThrow({
        where: { id: deployment.id },
      });
    }

    return { project, deployment, event, job, read };
  }

  it('claims a pending deployment and records ownership', async (t) => {
    const f = await fixture(t);
    const job = f.job(1);
    const token = randomUUID();

    assert.equal(
      await claimDeploymentExecution(job.value, QUEUE_TOKEN, token),
      true,
    );

    const current = await f.read();

    assert.equal(current.status, 'BUILDING');
    assert.equal(current.processingJobId, job.value.id);
    assert.equal(current.processingAttempt, 1);
    assert.equal(current.processingToken, token);
    assert.ok(current.processingStartedAt);
    assert.ok(current.buildStartedAt);
    assert.equal(current.buildFinishedAt, null);
    assert.equal(job.lockChecks(), 2);
  });

  it('replaces an older execution and rejects stale or duplicate claims', async (t) => {
    const f = await fixture(t);
    const oldToken = randomUUID();
    const newToken = randomUUID();

    assert.equal(
      await claimDeploymentExecution(f.job(1).value, QUEUE_TOKEN, oldToken),
      true,
    );

    const first = await f.read();

    assert.equal(
      await claimDeploymentExecution(f.job(2).value, QUEUE_TOKEN, newToken),
      true,
    );

    const replacement = await f.read();

    assert.equal(replacement.processingAttempt, 2);
    assert.equal(replacement.processingToken, newToken);
    assert.equal(
      replacement.buildStartedAt?.getTime(),
      first.buildStartedAt?.getTime(),
      'Recovery must preserve the original build start time.',
    );

    for (const attempt of [1, 2]) {
      assert.equal(
        await claimDeploymentExecution(
          f.job(attempt, [1]).value,
          QUEUE_TOKEN,
          randomUUID(),
        ),
        false,
      );
    }

    assert.deepEqual(await f.read(), replacement);
  });

  it('allows only one concurrent claim for the same execution', async (t) => {
    const f = await fixture(t);
    const tokens = [randomUUID(), randomUUID()];

    const results = await Promise.all(
      tokens.map((token) =>
        claimDeploymentExecution(f.job(1).value, QUEUE_TOKEN, token),
      ),
    );

    assert.equal(results.filter(Boolean).length, 1);

    const current = await f.read();
    const winner = results.findIndex((result) => result);

    assert.equal(current.processingToken, tokens[winner]);
    assert.equal(current.processingAttempt, 1);
  });

  it('does not change the deployment when the initial queue lock is lost', async (t) => {
    const f = await fixture(t);
    const before = await f.read();

    await assert.rejects(
      () =>
        claimDeploymentExecution(
          f.job(1, [0]).value,
          QUEUE_TOKEN,
          randomUUID(),
        ),
      /ownership was lost before claiming/,
    );

    assert.deepEqual(await f.read(), before);
  });

  it('rolls back a replacement claim when the second lock check fails', async (t) => {
    const f = await fixture(t);

    await claimDeploymentExecution(
      f.job(1).value,
      QUEUE_TOKEN,
      randomUUID(),
    );

    const before = await f.read();

    await assert.rejects(
      () =>
        claimDeploymentExecution(
          f.job(2, [1, 0]).value,
          QUEUE_TOKEN,
          randomUUID(),
        ),
      /ownership was lost during claiming/,
    );

    assert.deepEqual(
      await f.read(),
      before,
      'The previous execution must retain its complete database claim.',
    );
  });

  it('rejects a job whose commit does not match its persisted request', async (t) => {
    const f = await fixture(t);
    const job = f.job(1);
    const before = await f.read();

    job.value.data.commitSha = 'c'.repeat(40);

    await assert.rejects(
      () =>
        claimDeploymentExecution(
          job.value,
          QUEUE_TOKEN,
          randomUUID(),
        ),
      /does not match its outbox event/,
    );

    assert.equal(job.lockChecks(), 0);
    assert.deepEqual(await f.read(), before);
  });

  it('does not reclaim deployments in terminal states', async (t) => {
    const f = await fixture(t);

    await claimDeploymentExecution(
      f.job(1).value,
      QUEUE_TOKEN,
      randomUUID(),
    );

    for (const status of ['READY', 'FAILED', 'CANCELLED'] as const) {
      await prisma.deployment.update({
        where: { id: f.deployment.id },
        data: {
          status,
          processingToken: null,
          processingStartedAt: null,
          buildFinishedAt: new Date(),
        },
      });

      const before = await f.read();

      assert.equal(
        await claimDeploymentExecution(
          f.job(2, [1]).value,
          QUEUE_TOKEN,
          randomUUID(),
        ),
        false,
      );

      assert.deepEqual(await f.read(), before);
    }
  });
});