import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';

import { prisma } from '../../../src/config/database.js';
import { processGitHubWebhookDelivery } from '../../../src/services/github-webhooks.js';
import {
  DeploymentQuotaError,
  MAX_UNFINISHED_DEPLOYMENTS,
} from '../../../src/services/deployment-quota.js';
import { useTestData } from '../../support/test-data.js';

const COMMIT_SHA = 'f'.repeat(40);

describe('GitHub push deployment creation', () => {
  const data = useTestData();

  async function fixture(t: TestContext) {
    const owner = await data.createUser({ prefix: 'push_owner' });
    const projectIds: string[] = [];
    const installationRecordIds: string[] = [];
    const deliveryIds: string[] = [];

    t.after(async () => {
      const deployments = await prisma.deployment.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true },
      });

      await prisma.deploymentOutbox.deleteMany({
        where: {
          deploymentId: {
            in: deployments.map((deployment) => deployment.id),
          },
        },
      });

      await prisma.gitRepository.deleteMany({
        where: { projectId: { in: projectIds } },
      });

      await prisma.deployment.deleteMany({
        where: { projectId: { in: projectIds } },
      });

      await prisma.project.deleteMany({
        where: { id: { in: projectIds } },
      });

      await prisma.gitHubAppInstallation.deleteMany({
        where: { id: { in: installationRecordIds } },
      });

      await prisma.gitHubWebhookDelivery.deleteMany({
        where: { deliveryId: { in: deliveryIds } },
      });

      await prisma.deploymentQuotaLock.deleteMany({
        where: { scopeKey: `personal:${owner.id}` },
      });
    });

    const project = await prisma.project.create({
      data: {
        name: 'Webhook push test',
        slug: `push-test-${randomUUID()}`,
        ownerUserId: owner.id,
        teamId: null,
        rootDirectory: '.',
        installCommand: '',
        buildCommand: 'echo original-build',
        outputDirectory: '.',
        spaFallback: false,
      },
    });

    projectIds.push(project.id);

    // Positive safe integers suitable for the webhook payload.
    const installationId = randomInt(1_000_000_000_000, 2_000_000_000_000);
    const repositoryId = randomInt(2_000_000_000_000, 3_000_000_000_000);

    const installation = await prisma.gitHubAppInstallation.create({
      data: {
        installationId: BigInt(installationId),
        accountLogin: `test-${randomUUID()}`,
        accountType: 'User',
      },
    });

    installationRecordIds.push(installation.id);

    await prisma.gitRepository.create({
      data: {
        projectId: project.id,
        installationRecordId: installation.id,
        providerRepositoryId: BigInt(repositoryId),
        owner: 'test-owner',
        name: `test-repo-${randomUUID()}`,
        defaultBranch: 'main',
        productionBranch: 'main',
      },
    });

    const payload = {
      ref: 'refs/heads/main',
      after: COMMIT_SHA,
      deleted: false,
      repository: { id: repositoryId },
      installation: { id: installationId },
    };

    function newDeliveryId() {
      const id = randomUUID();
      deliveryIds.push(id);
      return id;
    }

    function deliver(
      deliveryId: string,
      body: unknown = payload,
    ) {
      return processGitHubWebhookDelivery({
        deliveryId,
        event: 'push',
        payload: body,
      });
    }

    function deployments() {
      return prisma.deployment.findMany({
        where: { projectId: project.id },
      });
    }

    async function requestEvents() {
      const rows = await deployments();

      return prisma.deploymentOutbox.findMany({
        where: {
          deploymentId: { in: rows.map((row) => row.id) },
          eventType: 'DEPLOYMENT_REQUESTED',
        },
      });
    }

    return {
      project,
      payload,
      newDeliveryId,
      deliver,
      deployments,
      requestEvents,
    };
  }

  it('creates one deployment and request event with saved build settings', async (t) => {
    const f = await fixture(t);
    const deliveryId = f.newDeliveryId();

    const result = await f.deliver(deliveryId);

    assert.equal(result.duplicate, false);
    assert.equal(result.status, 'PROCESSED');

    const deployments = await f.deployments();
    const events = await f.requestEvents();

    assert.equal(deployments.length, 1);
    assert.equal(events.length, 1);

    const deployment = deployments[0];
    assert.ok(deployment);

    assert.equal(deployment.status, 'PENDING');
    assert.equal(deployment.commitSha, COMMIT_SHA);
    assert.deepEqual(deployment.buildSettings, {
      version: 1,
      rootDirectory: '.',
      installCommand: '',
      buildCommand: 'echo original-build',
      outputDirectory: '.',
    });

    assert.deepEqual(events[0]?.payload, {
      deploymentId: deployment.id,
      projectId: f.project.id,
      source: 'github-push',
      repositoryId: f.payload.repository.id,
      ref: 'refs/heads/main',
      commitSha: COMMIT_SHA,
    });

    const receipt = await prisma.gitHubWebhookDelivery.findUniqueOrThrow({
      where: { deliveryId },
    });

    assert.equal(receipt.status, 'PROCESSED');
    assert.ok(receipt.processedAt);
    assert.equal(receipt.error, null);

    // Later settings changes must not alter this deployment's snapshot.
    await prisma.project.update({
      where: { id: f.project.id },
      data: { buildCommand: 'echo changed-build' },
    });

    const saved = await prisma.deployment.findUniqueOrThrow({
      where: { id: deployment.id },
    });

    assert.deepEqual(saved.buildSettings, deployment.buildSettings);
  });

  it('creates only one deployment for concurrent and later duplicate deliveries', async (t) => {
    const f = await fixture(t);
    const deliveryId = f.newDeliveryId();

    const results = await Promise.all([
      f.deliver(deliveryId),
      f.deliver(deliveryId),
      f.deliver(deliveryId),
    ]);

    assert.equal(
      results.filter((result) => !result.duplicate).length,
      1,
    );
    assert.equal(
      results.filter((result) => result.duplicate).length,
      2,
    );

    for (const result of results) {
      assert.equal(result.status, 'PROCESSED');
    }

    const repeated = await f.deliver(deliveryId);

    assert.equal(repeated.duplicate, true);
    assert.equal((await f.deployments()).length, 1);
    assert.equal((await f.requestEvents()).length, 1);
  });

  it('ignores pushes to another branch', async (t) => {
    const f = await fixture(t);

    const result = await f.deliver(f.newDeliveryId(), {
      ...f.payload,
      ref: 'refs/heads/feature-test',
    });

    assert.equal(result.status, 'IGNORED');
    assert.equal((await f.deployments()).length, 0);
    assert.equal((await f.requestEvents()).length, 0);
  });

  it('ignores a repository paired with the wrong installation', async (t) => {
    const f = await fixture(t);

    const result = await f.deliver(f.newDeliveryId(), {
      ...f.payload,
      installation: { id: f.payload.installation.id + 1 },
    });

    assert.equal(result.status, 'IGNORED');
    assert.equal((await f.deployments()).length, 0);
    assert.equal((await f.requestEvents()).length, 0);
  });

  it('ignores pushes to archived projects', async (t) => {
    const f = await fixture(t);

    await prisma.project.update({
      where: { id: f.project.id },
      data: { archivedAt: new Date() },
    });

    const result = await f.deliver(f.newDeliveryId());

    assert.equal(result.status, 'IGNORED');
    assert.equal((await f.deployments()).length, 0);
    assert.equal((await f.requestEvents()).length, 0);
  });

  it('ignores branch deletion events', async (t) => {
    const f = await fixture(t);

    const result = await f.deliver(f.newDeliveryId(), {
      ...f.payload,
      deleted: true,
      after: '0'.repeat(40),
    });

    assert.equal(result.status, 'IGNORED');
    assert.equal((await f.deployments()).length, 0);
    assert.equal((await f.requestEvents()).length, 0);
  });

  it('creates nothing when quota is full and processes redelivery after capacity is freed', async (t) => {
    const f = await fixture(t);
    const deliveryId = f.newDeliveryId();

    await prisma.deployment.createMany({
      data: Array.from(
        { length: MAX_UNFINISHED_DEPLOYMENTS },
        () => ({
          projectId: f.project.id,
          commitSha: COMMIT_SHA,
          status: 'PENDING' as const,
        }),
      ),
    });

    await assert.rejects(
      () => f.deliver(deliveryId),
      (error: unknown) =>
        error instanceof DeploymentQuotaError &&
        error.activeCount === MAX_UNFINISHED_DEPLOYMENTS,
    );

    assert.equal(
      (await f.deployments()).length,
      MAX_UNFINISHED_DEPLOYMENTS,
    );
    assert.equal((await f.requestEvents()).length, 0);

    const failedReceipt =
      await prisma.gitHubWebhookDelivery.findUniqueOrThrow({
        where: { deliveryId },
      });

    assert.equal(failedReceipt.status, 'FAILED');
    assert.equal(failedReceipt.processedAt, null);

    const pending = await prisma.deployment.findFirstOrThrow({
      where: { projectId: f.project.id, status: 'PENDING' },
    });

    await prisma.deployment.update({
      where: { id: pending.id },
      data: { status: 'FAILED' },
    });

    const retried = await f.deliver(deliveryId);

    assert.equal(retried.duplicate, false);
    assert.equal(retried.status, 'PROCESSED');
    assert.equal(
      (await f.deployments()).length,
      MAX_UNFINISHED_DEPLOYMENTS + 1,
    );
    assert.equal((await f.requestEvents()).length, 1);

    const receipt = await prisma.gitHubWebhookDelivery.findUniqueOrThrow({
      where: { deliveryId },
    });

    assert.equal(receipt.status, 'PROCESSED');
    assert.equal(receipt.error, null);
    assert.ok(receipt.processedAt);

    const duplicate = await f.deliver(deliveryId);

    assert.equal(duplicate.duplicate, true);
    assert.equal((await f.requestEvents()).length, 1);
  });
});