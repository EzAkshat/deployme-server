import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';

import { prisma } from '../../../src/config/database.js';
import {
  importPersonalProject,
  ProjectImportError,
} from '../../../src/services/project-import.js';
import {
  MAX_UNFINISHED_DEPLOYMENTS,
} from '../../../src/services/deployment-quota.js';
import { useTestData } from '../../support/test-data.js';

type ImportDependencies =
  NonNullable<Parameters<typeof importPersonalProject>[3]>;

const COMMIT_SHA = 'a'.repeat(40);

describe('personal project import idempotency', () => {
  const data = useTestData();

  async function fixture(t: TestContext) {
    const owner = await data.createUser({ prefix: 'import_owner' });
    const installationIds: string[] = [];

    t.after(async () => {
      const projects = await prisma.project.findMany({
        where: { ownerUserId: owner.id },
        select: { id: true },
      });

      const projectIds = projects.map((project) => project.id);

      const deployments = await prisma.deployment.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true },
      });

      // Import records restrict project/deployment deletion.
      await prisma.projectImportRequest.deleteMany({
        where: { userId: owner.id },
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
        where: { id: { in: installationIds } },
      });

      await prisma.deploymentQuotaLock.deleteMany({
        where: { scopeKey: `personal:${owner.id}` },
      });
    });

    const installationId = randomInt(
      1_000_000_000_000,
      2_000_000_000_000,
    );

    const installation = await prisma.gitHubAppInstallation.create({
      data: {
        installationId: BigInt(installationId),
        accountLogin: `import-${randomUUID()}`,
        accountType: 'User',
      },
    });

    installationIds.push(installation.id);

    const unique = randomUUID();
    const key = randomUUID();

    const input = {
      name: 'Import test project',
      slug: `import-${unique}`,
      subdomain: `import-${unique}`,
      installationId,
      repositoryId: randomInt(
        2_000_000_000_000,
        3_000_000_000_000,
      ),
      owner: 'test-owner',
      repositoryName: `repo-${unique}`,
      commitSha: COMMIT_SHA,
      rootDirectory: '.',
      installCommand: '',
      buildCommand: '',
      outputDirectory: '.',
      spaFallback: false,
      settingsReviewed: true,
    };

    const dependencies: ImportDependencies = {
      inspect: async (userId, details) => {
        assert.equal(userId, owner.id);
        assert.equal(details.repositoryId, input.repositoryId);
        assert.equal(details.installationId, installationId);

        return {
          commitSha: COMMIT_SHA,
          defaultBranch: 'main',
          requiresReview: true,
          settings: {
            installCommand: '',
            buildCommand: '',
            outputDirectory: '.',
            spaFallback: false,
          },
        };
      },
      syncInstallation: async (requestedId) => {
        assert.equal(requestedId, installationId);
        return { id: installation.id };
      },
    };

    const unavailableGitHub: ImportDependencies = {
      inspect: async () => {
        throw new Error('Replay unexpectedly contacted GitHub inspection');
      },
      syncInstallation: async () => {
        throw new Error('Replay unexpectedly synchronized GitHub');
      },
    };

    async function counts() {
      const projects = await prisma.project.findMany({
        where: { ownerUserId: owner.id },
        select: { id: true },
      });

      const projectIds = projects.map((project) => project.id);

      const deployments = await prisma.deployment.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true },
      });

      return {
        projects: projects.length,
        repositories: await prisma.gitRepository.count({
          where: { projectId: { in: projectIds } },
        }),
        deployments: deployments.length,
        events: await prisma.deploymentOutbox.count({
          where: {
            deploymentId: {
              in: deployments.map((deployment) => deployment.id),
            },
          },
        }),
        imports: await prisma.projectImportRequest.count({
          where: { userId: owner.id },
        }),
      };
    }

    return {
      owner,
      key,
      input,
      dependencies,
      unavailableGitHub,
      counts,
    };
  }

  const oneImport = {
    projects: 1,
    repositories: 1,
    deployments: 1,
    events: 1,
    imports: 1,
  };

  it('creates one import and replays it regardless of JSON property order', async (t) => {
    const f = await fixture(t);

    const first = await importPersonalProject(
      f.owner.id,
      f.key,
      f.input,
      f.dependencies,
    );

    assert.equal(first.replayed, false);
    assert.equal(first.deployment.commitSha, COMMIT_SHA);

    const reordered = Object.fromEntries(
      Object.entries(f.input).reverse(),
    );

    const replay = await importPersonalProject(
      f.owner.id,
      f.key,
      reordered,
      f.unavailableGitHub,
    );

    assert.equal(replay.replayed, true);
    assert.equal(replay.project.id, first.project.id);
    assert.equal(replay.deployment.id, first.deployment.id);
    assert.deepEqual(await f.counts(), oneImport);

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: first.deployment.id },
    });

    assert.deepEqual(deployment.buildSettings, {
      version: 1,
      rootDirectory: '.',
      installCommand: '',
      buildCommand: '',
      outputDirectory: '.',
    });
  });

  it('creates only one import when identical requests reach the transaction concurrently', async (t) => {
    const f = await fixture(t);

    // Both requests must pass the initial replay lookup before proceeding.
    let inspections = 0;
    let release!: () => void;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const dependencies: ImportDependencies = {
      ...f.dependencies,
      inspect: async (...args) => {
        inspections += 1;
        if (inspections === 2) release();

        await gate;
        return f.dependencies.inspect(...args);
      },
    };

    const results = await Promise.all([
      importPersonalProject(f.owner.id, f.key, f.input, dependencies),
      importPersonalProject(f.owner.id, f.key, f.input, dependencies),
    ]);

    assert.equal(inspections, 2);
    assert.equal(
      results.filter((result) => result.replayed === false).length,
      1,
    );
    assert.equal(
      results.filter((result) => result.replayed === true).length,
      1,
    );

    assert.equal(results[0]?.project.id, results[1]?.project.id);
    assert.equal(results[0]?.deployment.id, results[1]?.deployment.id);
    assert.deepEqual(await f.counts(), oneImport);
  });

  it('rejects reuse of a key with different settings', async (t) => {
    const f = await fixture(t);

    await importPersonalProject(
      f.owner.id,
      f.key,
      f.input,
      f.dependencies,
    );

    await assert.rejects(
      () =>
        importPersonalProject(
          f.owner.id,
          f.key,
          { ...f.input, buildCommand: 'echo changed' },
          f.unavailableGitHub,
        ),
      (error: unknown) =>
        error instanceof ProjectImportError &&
        error.status === 409 &&
        /different import settings/.test(error.message),
    );

    assert.deepEqual(await f.counts(), oneImport);
  });

  it('rejects replay after the imported project is archived', async (t) => {
    const f = await fixture(t);

    const first = await importPersonalProject(
      f.owner.id,
      f.key,
      f.input,
      f.dependencies,
    );

    await prisma.project.update({
      where: { id: first.project.id },
      data: { archivedAt: new Date() },
    });

    await assert.rejects(
      () =>
        importPersonalProject(
          f.owner.id,
          f.key,
          f.input,
          f.unavailableGitHub,
        ),
      (error: unknown) =>
        error instanceof ProjectImportError &&
        error.status === 409 &&
        /no longer available/.test(error.message),
    );

    assert.deepEqual(await f.counts(), oneImport);
  });

  it('replays an existing import even when deployment capacity is full', async (t) => {
    const f = await fixture(t);

    const first = await importPersonalProject(
      f.owner.id,
      f.key,
      f.input,
      f.dependencies,
    );

    await prisma.deployment.createMany({
      data: Array.from(
        { length: MAX_UNFINISHED_DEPLOYMENTS - 1 },
        () => ({
          projectId: first.project.id,
          commitSha: COMMIT_SHA,
          status: 'PENDING' as const,
        }),
      ),
    });

    const before = await f.counts();

    const replay = await importPersonalProject(
      f.owner.id,
      f.key,
      f.input,
      f.unavailableGitHub,
    );

    assert.equal(replay.replayed, true);
    assert.equal(replay.deployment.id, first.deployment.id);
    assert.deepEqual(await f.counts(), before);
    assert.equal(before.deployments, MAX_UNFINISHED_DEPLOYMENTS);
  });
});