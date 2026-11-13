import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';

import { prisma } from '../../../src/config/database.js';
import {
  DeploymentQuotaError,
  MAX_UNFINISHED_DEPLOYMENTS,
  enforceProjectDeploymentQuota,
} from '../../../src/services/deployment-quota.js';
import { useTestData } from '../../support/test-data.js';

const COMMIT_SHA = 'a'.repeat(40);
const ACTIVE_STATUSES = ['PENDING', 'QUEUED', 'BUILDING'] as const;

describe('deployment admission quotas', () => {
  const data = useTestData();

  async function fixture(
    t: TestContext,
    kind: 'personal' | 'team' = 'personal',
  ) {
    const owner = await data.createUser({ prefix: 'quota_owner' });

    const team =
      kind === 'team'
        ? await prisma.team.create({
            data: {
              name: 'Quota test team',
              slug: `quota-team-${randomUUID()}`,
            },
          })
        : null;

    if (team) data.trackTeam(team.id);

    const projectIds: string[] = [];
    const scopeKey = team
      ? `team:${team.id}`
      : `personal:${owner.id}`;

    t.after(async () => {
      if (projectIds.length > 0) {
        await prisma.deployment.deleteMany({
          where: { projectId: { in: projectIds } },
        });

        await prisma.project.deleteMany({
          where: { id: { in: projectIds } },
        });
      }

      await prisma.deploymentQuotaLock.deleteMany({
        where: { scopeKey },
      });
    });

    async function createProject() {
      const project = await prisma.project.create({
        data: {
          name: 'Quota test project',
          slug: `quota-project-${randomUUID()}`,
          ownerUserId: team ? null : owner.id,
          teamId: team?.id ?? null,
          rootDirectory: '.',
          installCommand: '',
          buildCommand: '',
          outputDirectory: '.',
          spaFallback: false,
        },
      });

      projectIds.push(project.id);
      return project;
    }

    const first = await createProject();
    const second = await createProject();

    return { first, second, projectIds };
  }

  async function admit(projectId: string, failAfterCreate = false) {
    return prisma.$transaction(
      async (tx) => {
        await enforceProjectDeploymentQuota(tx, projectId);

        const deployment = await tx.deployment.create({
          data: {
            projectId,
            commitSha: COMMIT_SHA,
            status: 'PENDING',
          },
        });

        if (failAfterCreate) {
          throw new Error('Intentional transaction rollback');
        }

        return deployment;
      },
      {
        isolationLevel: 'ReadCommitted',
        maxWait: 15_000,
        timeout: 15_000,
      },
    );
  }

  function isQuotaError(error: unknown): boolean {
    return (
      error instanceof DeploymentQuotaError &&
      error.code === 'DEPLOYMENT_QUOTA_EXCEEDED' &&
      error.activeCount === MAX_UNFINISHED_DEPLOYMENTS &&
      error.limit === MAX_UNFINISHED_DEPLOYMENTS
    );
  }

  for (const kind of ['personal', 'team'] as const) {
    it(`enforces one shared ${kind} limit across concurrent project requests`, async (t) => {
      const f = await fixture(t, kind);
      const requestCount = MAX_UNFINISHED_DEPLOYMENTS + 3;

      // No lock row is pre-created: this also exercises first-use contention.
      const results = await Promise.allSettled(
        Array.from({ length: requestCount }, (_, index) =>
          admit(index % 2 === 0 ? f.first.id : f.second.id),
        ),
      );

      const accepted = results.filter(
        (result) => result.status === 'fulfilled',
      );

      const rejected = results.filter(
        (result) => result.status === 'rejected',
      );

      assert.equal(accepted.length, MAX_UNFINISHED_DEPLOYMENTS);
      assert.equal(rejected.length, 3);

      for (const result of rejected) {
        if (result.status === 'rejected') {
          assert.ok(
            isQuotaError(result.reason),
            `Expected a quota rejection; received ${String(result.reason)}`,
          );
        }
      }

      assert.equal(
        await prisma.deployment.count({
          where: { projectId: { in: f.projectIds } },
        }),
        MAX_UNFINISHED_DEPLOYMENTS,
        'Rejected requests must not create deployment rows.',
      );
    });
  }

  it('counts all unfinished statuses and frees capacity after completion', async (t) => {
    const f = await fixture(t);

    await prisma.deployment.createMany({
      data: Array.from(
        { length: MAX_UNFINISHED_DEPLOYMENTS },
        (_, index) => ({
          projectId: f.first.id,
          commitSha: COMMIT_SHA,
          status: ACTIVE_STATUSES[index % ACTIVE_STATUSES.length]!,
        }),
      ),
    });

    // Terminal deployments must not consume additional quota.
    await prisma.deployment.createMany({
      data: (['READY', 'FAILED', 'CANCELLED'] as const).map((status) => ({
        projectId: f.second.id,
        commitSha: COMMIT_SHA,
        status,
      })),
    });

    await assert.rejects(() => admit(f.second.id), isQuotaError);

    const pending = await prisma.deployment.findFirstOrThrow({
      where: { projectId: f.first.id, status: 'PENDING' },
    });

    await prisma.deployment.update({
      where: { id: pending.id },
      data: { status: 'FAILED' },
    });

    const admitted = await admit(f.second.id);
    assert.equal(admitted.status, 'PENDING');

    await assert.rejects(() => admit(f.second.id), isQuotaError);
  });

  it('counts unfinished deployments belonging to archived projects', async (t) => {
    const f = await fixture(t);

    await prisma.deployment.createMany({
      data: Array.from(
        { length: MAX_UNFINISHED_DEPLOYMENTS },
        () => ({
          projectId: f.first.id,
          commitSha: COMMIT_SHA,
          status: 'PENDING' as const,
        }),
      ),
    });

    await prisma.project.update({
      where: { id: f.first.id },
      data: { archivedAt: new Date() },
    });

    // The second project is active but shares the same owner's quota.
    await assert.rejects(() => admit(f.second.id), isQuotaError);
  });

  it('keeps different personal accounts independent', async (t) => {
    const firstAccount = await fixture(t);
    const secondAccount = await fixture(t);

    for (let index = 0; index < MAX_UNFINISHED_DEPLOYMENTS; index++) {
      await admit(firstAccount.first.id);
    }

    await assert.rejects(
      () => admit(firstAccount.second.id),
      isQuotaError,
    );

    const admitted = await admit(secondAccount.first.id);
    assert.equal(admitted.status, 'PENDING');
  });

  it('rolls back a failed admission without consuming capacity', async (t) => {
    const f = await fixture(t);

    await assert.rejects(
      () => admit(f.first.id, true),
      /Intentional transaction rollback/,
    );

    assert.equal(
      await prisma.deployment.count({
        where: { projectId: { in: f.projectIds } },
      }),
      0,
    );

    for (let index = 0; index < MAX_UNFINISHED_DEPLOYMENTS; index++) {
      await admit(f.first.id);
    }

    await assert.rejects(() => admit(f.second.id), isQuotaError);
  });
});