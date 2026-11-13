import { setTimeout as delay } from 'node:timers/promises';

import { prisma } from '../config/database.js';
import { r2BucketName } from '../config/r2.js';
import { createArtifactObjectKey } from './artifact-object.js';
import {
  isDisabledDeliveryRoute,
  readDeliveryRoute,
  writeDeliveryRoute,
} from './delivery-route-storage.js';

function readStoredRoute(record: unknown) {
  if (
    typeof record !== 'object' ||
    record === null ||
    !('version' in record) ||
    record.version !== 1 ||
    !('artifactPrefix' in record) ||
    typeof record.artifactPrefix !== 'string'
  ) {
    throw new Error('Invalid existing delivery routing record');
  }

  // Reuse the publisher's prefix validation.
  createArtifactObjectKey(record.artifactPrefix, 'index.html');

  const spaFallback = 'spaFallback' in record ? record.spaFallback : false;

  if (typeof spaFallback !== 'boolean') {
    throw new Error('Invalid SPA fallback setting in delivery routing record');
  }

  return { artifactPrefix: record.artifactPrefix, spaFallback };
}

export type RoutingResult = 'published' | 'unchanged' | 'superseded' | 'inactive';

export async function reconcileDeploymentRoute(
  deploymentId: string,
  projectId: string,
): Promise<RoutingResult> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const deployment = await prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        projectId: true,
        status: true,
        createdAt: true,
        artifactBucket: true,
        artifactPrefix: true,
        project: {
          select: {
            archivedAt: true,
            subdomain: true,
            spaFallback: true,
          },
        },
      },
    });

    if (!deployment || deployment.projectId !== projectId) {
      throw new Error('Routing deployment not found or project mismatch');
    }

    if (deployment.status !== 'READY' || deployment.project.archivedAt !== null) {
      return 'inactive';
    }

    const subdomain = deployment.project.subdomain;
    const prefix = deployment.artifactPrefix;

    if (!subdomain) {
      throw new Error('Project has no assigned subdomain');
    }

    if (
      deployment.artifactBucket !== r2BucketName ||
      !prefix ||
      !prefix.startsWith(`projects/${projectId}/deployments/${deploymentId}/`)
    ) {
      throw new Error('Deployment has an invalid artifact location');
    }

    createArtifactObjectKey(prefix, 'index.html');

    const existing = await readDeliveryRoute(subdomain);
    // A disabled route is a persistent barrier against delayed publishers.
    // Restoring a project will require a separate, explicit workflow.
    if (existing !== null && isDisabledDeliveryRoute(existing.record)) {
      if (existing.record.projectId !== projectId) {
        throw new Error('Disabled route belongs to another project');
      }

      return 'inactive';
    }
    if (existing !== null) {
      const { artifactPrefix: existingPrefix, spaFallback } = readStoredRoute(existing.record);

      if (existingPrefix === prefix && spaFallback === deployment.project.spaFallback) {
        return 'unchanged';
      }

      // Derive ordering from the database, including for legacy records
      // that contain only version and artifactPrefix.
      const current = await prisma.deployment.findFirst({
        where: {
          projectId,
          artifactBucket: r2BucketName,
          artifactPrefix: existingPrefix,
          status: 'READY',
        },
        select: {
          id: true,
          createdAt: true,
        },
      });

      if (!current) {
        throw new Error('Existing route does not match a READY deployment in this project');
      }

      const currentTime = current.createdAt.getTime();
      const candidateTime = deployment.createdAt.getTime();

      // Request creation time determines order, not build finish time.
      // IDs provide a deterministic tie-breaker for equal timestamps.
      if (
        currentTime > candidateTime ||
        (currentTime === candidateTime && current.id > deployment.id)
      ) {
        return 'superseded';
      }
    }

    const written = await writeDeliveryRoute(
      subdomain,
      {
        version: 1,
        projectId,
        deploymentId,
        deploymentCreatedAt: deployment.createdAt.toISOString(),
        artifactPrefix: prefix,
        spaFallback: deployment.project.spaFallback,
      },
      existing?.etag ?? null,
    );

    if (written) {
      return 'published';
    }

    // Another handler changed the record. Re-read before deciding again.
    await delay(100 * (attempt + 1));
  }

  throw new Error('Delivery route changed repeatedly; retry the event');
}
