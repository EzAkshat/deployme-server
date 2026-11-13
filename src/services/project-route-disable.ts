import { setTimeout as delay } from 'node:timers/promises';

import { prisma } from '../config/database.js';
import { createArtifactObjectKey } from './artifact-object.js';
import {
  isDisabledDeliveryRoute,
  readDeliveryRoute,
  writeDeliveryRoute,
} from './delivery-route-storage.js';

export type DisableProjectRouteResult =
  | 'disabled'
  | 'unchanged'
  | 'no-subdomain';

function requireRouteOwnership(
  record: unknown,
  projectId: string,
): void {
  if (
    typeof record !== 'object' ||
    record === null ||
    !('version' in record) ||
    record.version !== 1 ||
    !('artifactPrefix' in record) ||
    typeof record.artifactPrefix !== 'string'
  ) {
    throw new Error('Cannot disable an invalid delivery routing record');
  }

  createArtifactObjectKey(record.artifactPrefix, 'index.html');

  // Legacy route records may not contain projectId.
  if (
    !record.artifactPrefix.startsWith(
      `projects/${projectId}/deployments/`,
    )
  ) {
    throw new Error('Delivery route belongs to another project');
  }

  if ('projectId' in record && record.projectId !== projectId) {
    throw new Error('Delivery route project identity does not match');
  }
}

export async function disableArchivedProjectRoute(
  projectId: string,
): Promise<DisableProjectRouteResult> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        archivedAt: true,
        subdomain: true,
      },
    });

    if (!project) {
      throw new Error('Archived project was not found');
    }

    if (project.archivedAt === null) {
      throw new Error('Refusing to disable an active project');
    }

    if (!project.subdomain) {
      return 'no-subdomain';
    }

    const existing = await readDeliveryRoute(project.subdomain);

    if (existing !== null) {
      if (isDisabledDeliveryRoute(existing.record)) {
        if (existing.record.projectId !== projectId) {
          throw new Error('Disabled route belongs to another project');
        }

        return 'unchanged';
      }

      requireRouteOwnership(existing.record, projectId);
    }

    const written = await writeDeliveryRoute(
      project.subdomain,
      {
        version: 1,
        projectId,
        disabled: true,
      },
      existing?.etag ?? null,
    );

    if (written) {
      return 'disabled';
    }

    // A publisher changed the route. Read its new ETag and try again.
    await delay(100 * (attempt + 1));
  }

  throw new Error('Delivery route changed repeatedly; retry archival');
}