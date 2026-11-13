import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, afterEach, describe, it } from 'node:test';

import { prisma } from '../../../src/config/database.js';
import { r2BucketName } from '../../../src/config/r2.js';
import {
  reconcileDeploymentRoute,
  type DeploymentRoutingStorage,
} from '../../../src/services/deployment-routing.js';
import {
  disableArchivedProjectRoute,
} from '../../../src/services/project-route-disable.js';
import type {
  StoredDeliveryRoute,
} from '../../../src/services/delivery-route-storage.js';

describe('archive delivery routing protection', () => {
  let ownerId: number | undefined;
  let projectId: string;
  let deploymentId: string;
  let artifactPrefix: string;

  beforeEach(async () => {
    const suffix = randomUUID().replaceAll('-', '');

    const owner = await prisma.user.create({
      data: {
        email: `archive-routing-${suffix}@example.com`,
        username: `ar_${suffix.slice(0, 16)}`,
        name: 'Archive Routing Test',
      },
    });
    ownerId = owner.id;

    const project = await prisma.project.create({
      data: {
        ownerUserId: owner.id,
        name: 'Archive Routing Test',
        slug: `ar-${suffix}`,
        subdomain: `ar-${suffix}`,
      },
    });
    projectId = project.id;

    deploymentId = `test-${suffix}`;
    artifactPrefix =
      `projects/${projectId}/deployments/${deploymentId}/${randomUUID()}/`;

    await prisma.deployment.create({
      data: {
        id: deploymentId,
        projectId,
        commitSha: 'a'.repeat(40),
        status: 'READY',
        artifactBucket: r2BucketName,
        artifactPrefix,
      },
    });
  });

  afterEach(async () => {
    if (ownerId !== undefined) {
      await prisma.project.deleteMany({
        where: { ownerUserId: ownerId },
      });
      await prisma.user.deleteMany({
        where: { id: ownerId },
      });
      ownerId = undefined;
    }
  });

  after(async () => {
    await prisma.$disconnect();
  });

  async function archive() {
    await prisma.project.update({
      where: { id: projectId },
      data: { archivedAt: new Date() },
    });
  }

  function disabledRoute(): StoredDeliveryRoute {
    return {
      etag: '"disabled"',
      record: { version: 1, projectId, disabled: true },
    };
  }

  function unexpectedStorage(): DeploymentRoutingStorage {
    return {
      async readDeliveryRoute() {
        throw new Error('Unexpected storage read');
      },
      async writeDeliveryRoute() {
        throw new Error('Unexpected storage write');
      },
    };
  }

  it('does not access storage when publishing an archived project', async () => {
    await archive();

    assert.equal(
      await reconcileDeploymentRoute(
        deploymentId,
        projectId,
        unexpectedStorage(),
      ),
      'inactive',
    );
  });

  it('treats a disabled route as a barrier even with an active database row', async () => {
    assert.equal(
      await reconcileDeploymentRoute(deploymentId, projectId, {
        ...unexpectedStorage(),
        async readDeliveryRoute() {
          return disabledRoute();
        },
      }),
      'inactive',
    );
  });

  it('stops a delayed publisher after its write conflicts with archival', async () => {
    let reads = 0;
    let writes = 0;

    const result = await reconcileDeploymentRoute(
      deploymentId,
      projectId,
      {
        async readDeliveryRoute() {
          reads += 1;
          return reads === 1 ? null : disabledRoute();
        },
        async writeDeliveryRoute(_subdomain, record, previousEtag) {
          writes += 1;
          assert.equal(previousEtag, null);
          assert.ok('deploymentId' in record);
          // Simulate archival creating a tombstone before this write.
          return false;
        },
      },
    );

    assert.equal(result, 'inactive');
    assert.equal(reads, 2);
    assert.equal(writes, 1);
  });

  it('refuses to disable an active project before accessing storage', async () => {
    await assert.rejects(
      disableArchivedProjectRoute(projectId, unexpectedStorage()),
      /Refusing to disable an active project/,
    );
  });

  it('creates a tombstone when an archived project has no routing record', async () => {
    await archive();
    let writes = 0;

    const result = await disableArchivedProjectRoute(projectId, {
      async readDeliveryRoute() {
        return null;
      },
      async writeDeliveryRoute(_subdomain, record, previousEtag) {
        writes += 1;
        assert.equal(previousEtag, null);
        assert.deepEqual(record, {
          version: 1,
          projectId,
          disabled: true,
        });
        return true;
      },
    });

    assert.equal(result, 'disabled');
    assert.equal(writes, 1);
  });

  it('re-reads the ETag and retries when a publisher changes the route', async () => {
    await archive();
    let reads = 0;
    const suppliedEtags: Array<string | null> = [];

    const result = await disableArchivedProjectRoute(projectId, {
      async readDeliveryRoute() {
        reads += 1;
        return {
          etag: reads === 1 ? '"old"' : '"new"',
          record: { version: 1, artifactPrefix },
        };
      },
      async writeDeliveryRoute(_subdomain, record, previousEtag) {
        suppliedEtags.push(previousEtag);
        assert.deepEqual(record, {
          version: 1,
          projectId,
          disabled: true,
        });
        return suppliedEtags.length === 2;
      },
    });

    assert.equal(result, 'disabled');
    assert.deepEqual(suppliedEtags, ['"old"', '"new"']);
    assert.equal(reads, 2);
  });

  it('leaves an existing tombstone unchanged', async () => {
    await archive();

    assert.equal(
      await disableArchivedProjectRoute(projectId, {
        ...unexpectedStorage(),
        async readDeliveryRoute() {
          return disabledRoute();
        },
      }),
      'unchanged',
    );
  });

  it('refuses to overwrite a disabled route owned by another project', async () => {
    await archive();

    const storage: DeploymentRoutingStorage = {
      ...unexpectedStorage(),
      async readDeliveryRoute() {
        return {
          etag: '"other"',
          record: {
            version: 1,
            projectId: 'another-project',
            disabled: true,
          },
        };
      },
    };

    await assert.rejects(
      disableArchivedProjectRoute(projectId, storage),
      /Disabled route belongs to another project/,
    );
  });
});