import { ListObjectsV2Command } from '@aws-sdk/client-s3';

import { prisma } from '../config/database.js';
import { r2, r2BucketName } from '../config/r2.js';
import { createArtifactObjectKey } from '../services/artifact-object.js';
import {
  isDisabledDeliveryRoute,
  readDeliveryRoute,
} from '../services/delivery-route-storage.js';

const GRACE_MS = 24 * 60 * 60 * 1_000;
const MAX_PAGES = 100;

interface Attempt {
  prefix: string;
  deploymentId: string;
  processingToken: string;
  objectCount: number;
  observedBytes: number;
  newestObjectMs: number;
  metadataComplete: boolean;
}

type Classification = 'retained' | 'deferred' | 'review' | 'candidate';

async function main(): Promise<void> {
  const projectId = process.argv[2];

  if (!projectId || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) {
    throw new Error('Provide one valid project ID as the command argument.');
  }

  const scanStartedAt = new Date();
  const cutoff = scanStartedAt.getTime() - GRACE_MS;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      subdomain: true,
      archivedAt: true,
    },
  });

  if (!project) {
    throw new Error('Project not found. No report generated.');
  }

  const rootPrefix = `projects/${projectId}/deployments/`;
  const attempts = new Map<string, Attempt>();
  let unrecognizedObjectCount = 0;
  let continuationToken: string | undefined;
  let listingComplete = false;
  const seenTokens = new Set<string>();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await r2.send(
      new ListObjectsV2Command({
        Bucket: r2BucketName,
        Prefix: rootPrefix,
        MaxKeys: 1_000,
        ...(continuationToken
          ? { ContinuationToken: continuationToken }
          : {}),
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );

    for (const object of response.Contents ?? []) {
      const key = object.Key;

      if (!key || !key.startsWith(rootPrefix)) {
        unrecognizedObjectCount += 1;
        continue;
      }

      const match =
        /^([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/(.+)$/.exec(
          key.slice(rootPrefix.length),
        );

      const deploymentId = match?.[1];
      const processingToken = match?.[2];

      if (!deploymentId || !processingToken) {
        unrecognizedObjectCount += 1;
        continue;
      }

      const prefix =
        `${rootPrefix}${deploymentId}/${processingToken}/`;

      let attempt = attempts.get(prefix);

      if (!attempt) {
        attempt = {
          prefix,
          deploymentId,
          processingToken,
          objectCount: 0,
          observedBytes: 0,
          newestObjectMs: 0,
          metadataComplete: true,
        };
        attempts.set(prefix, attempt);
      }

      attempt.objectCount += 1;

      const size = object.Size;
      const modifiedAt = object.LastModified?.getTime();

      if (
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size < 0
      ) {
        attempt.metadataComplete = false;
      } else {
        attempt.observedBytes += size;
      }

      if (
        modifiedAt === undefined ||
        !Number.isFinite(modifiedAt) ||
        modifiedAt <= 0
      ) {
        attempt.metadataComplete = false;
      } else {
        attempt.newestObjectMs = Math.max(
          attempt.newestObjectMs,
          modifiedAt,
        );
      }
    }

    if (!response.IsTruncated) {
      listingComplete = true;
      break;
    }

    const next = response.NextContinuationToken;

    if (!next || seenTokens.has(next)) {
      throw new Error('R2 returned invalid pagination. Report aborted.');
    }

    seenTokens.add(next);
    continuationToken = next;
  }

  if (!listingComplete) {
    throw new Error(
      'Project exceeds the scan page limit. No complete report generated.',
    );
  }

  // Read the current project's delivery route after listing.
  // Route-read errors abort the report rather than implying no reference.
  let livePrefix: string | null = null;
  let routeState = 'not_configured';

  if (project.subdomain) {
    const route = await readDeliveryRoute(project.subdomain);

    if (!route) {
      routeState = 'missing';
    } else if (isDisabledDeliveryRoute(route.record)) {
      if (route.record.projectId !== projectId) {
        throw new Error('Disabled delivery route belongs to another project.');
      }

      routeState = 'disabled';
    } else {
      const record = route.record;

      if (
        typeof record !== 'object' ||
        record === null ||
        !('version' in record) ||
        record.version !== 1 ||
        !('artifactPrefix' in record) ||
        typeof record.artifactPrefix !== 'string'
      ) {
        throw new Error('Delivery route is malformed. Report aborted.');
      }

      createArtifactObjectKey(record.artifactPrefix, 'index.html');

      if (
        !record.artifactPrefix.startsWith(rootPrefix) ||
        ('projectId' in record && record.projectId !== projectId)
      ) {
        throw new Error('Delivery route project mismatch. Report aborted.');
      }

      livePrefix = record.artifactPrefix;
      routeState = 'active';
    }
  }

  const counts: Record<Classification, number> = {
    retained: 0,
    deferred: 0,
    review: 0,
    candidate: 0,
  };

  const results = [];
  let candidateBytes = 0;

  for (const attempt of attempts.values()) {
    const [reference, deployment] = await Promise.all([
      // Preserve any DB reference, even one with an inconsistent bucket.
      prisma.deployment.findFirst({
        where: { artifactPrefix: attempt.prefix },
        select: { id: true },
      }),
      prisma.deployment.findUnique({
        where: { id: attempt.deploymentId },
        select: {
          projectId: true,
          status: true,
          processingToken: true,
          updatedAt: true,
        },
      }),
    ]);

    let classification: Classification;
    let reason: string;

    if (livePrefix === attempt.prefix) {
      classification = 'retained';
      reason = 'Referenced by the current project delivery route.';
    } else if (reference) {
      classification = 'retained';
      reason = 'Referenced by a stored deployment.';
    } else if (!deployment || deployment.projectId !== projectId) {
      classification = 'review';
      reason = 'Deployment is missing or belongs to another project.';
    } else if (!attempt.metadataComplete) {
      classification = 'review';
      reason = 'Object size or modification metadata is incomplete.';
    } else if (
      !['READY', 'FAILED', 'CANCELLED'].includes(deployment.status)
    ) {
      classification = 'deferred';
      reason = 'Deployment is not terminal.';
    } else if (deployment.processingToken !== null) {
      classification = 'deferred';
      reason = 'Deployment still has a processing owner.';
    } else if (
      attempt.newestObjectMs > cutoff ||
      deployment.updatedAt.getTime() > cutoff
    ) {
      classification = 'deferred';
      reason = 'Objects or deployment changed within the 24-hour grace period.';
    } else {
      classification = 'candidate';
      reason = 'Old attempt with no observed deployment or current-route reference.';
      candidateBytes += attempt.observedBytes;
    }

    counts[classification] += 1;

    results.push({
      prefix: attempt.prefix,
      deploymentId: attempt.deploymentId,
      classification,
      reason,
      objectCount: attempt.objectCount,
      observedBytes: attempt.observedBytes,
      newestObjectAt:
        attempt.newestObjectMs > 0
          ? new Date(attempt.newestObjectMs).toISOString()
          : null,
    });
  }

  console.log(JSON.stringify({
    mode: 'read-only',
    projectId,
    bucket: r2BucketName,
    scanStartedAt,
    scanFinishedAt: new Date(),
    listingComplete,
    graceHours: 24,
    routeState,
    archivedAt: project.archivedAt,
    attemptCount: attempts.size,
    unrecognizedObjectCount,
    counts,
    candidateBytes,
    results,
  }, null, 2));
}

try {
  await main();
} catch (error: unknown) {
  console.error(
    'Artifact scan failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
} finally {
  r2.destroy();
  await prisma.$disconnect();
}