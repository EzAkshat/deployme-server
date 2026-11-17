import { randomUUID } from 'node:crypto';
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

import { prisma } from '../config/database.js';
import { r2, r2BucketName } from '../config/r2.js';
import { createArtifactPrefix, createArtifactObjectKey } from './artifact-object.js';
import { isDisabledDeliveryRoute, readDeliveryRoute } from './delivery-route-storage.js';
import type { DeleteObjectsCommandOutput, ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';

const CLAIM_LEASE_MS = 5 * 60_000;
const RETRY_DELAY_MS = 60_000;
const PROTECTED_RECHECK_MS = 60 * 60_000;
const CLEANED_RECHECK_MS = 24 * 60 * 60_000;

// At most one page is deleted per invocation.
// Subsequent invocations start listing from the beginning again.
const PAGE_SIZE = 1_000;

export interface ArtifactCleanupStorage {
  readDeliveryRoute: typeof readDeliveryRoute;

  listObjects(
    bucket: string,
    prefix: string,
    limit: number,
  ): Promise<Pick<ListObjectsV2CommandOutput, 'Contents' | 'IsTruncated'>>;

  deleteObjects(
    bucket: string,
    keys: string[],
  ): Promise<Pick<DeleteObjectsCommandOutput, 'Errors'>>;
}

const defaultStorage: ArtifactCleanupStorage = {
  readDeliveryRoute,

  async listObjects(bucket, prefix, limit) {
    return r2.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: limit,
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  },

  async deleteObjects(bucket, keys) {
    return r2.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: keys.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  },
};

interface ArtifactCleanupOptions {
  attemptId?: string;
  storage?: ArtifactCleanupStorage;
}

let running = false;

class ProtectedArtifactError extends Error {}

function cleanupStatuses() {
  return ['CLEANUP_PENDING', 'CLEANED'] as const;
}

export async function processArtifactUploadCleanup(
  options: ArtifactCleanupOptions = {},
): Promise<number> {
  const storage = options.storage ?? defaultStorage;
  if (running) return 0;
  running = true;

  try {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS);

    const candidate = await prisma.artifactUploadAttempt.findFirst({
      where: {
        ...(options.attemptId !== undefined ? { id: options.attemptId } : {}),
        status: { in: [...cleanupStatuses()] },
        cleanupAfter: { lte: now },
        OR: [
          { claimToken: null },
          {
            claimToken: { not: null },
            claimedAt: { lt: staleBefore },
          },
        ],
      },
      orderBy: [{ cleanupAfter: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });

    if (!candidate) return 0;

    const claimToken = randomUUID();

    const claimed = await prisma.artifactUploadAttempt.updateMany({
      where: {
        id: candidate.id,
        status: { in: [...cleanupStatuses()] },
        cleanupAfter: { lte: now },
        OR: [
          { claimToken: null },
          {
            claimToken: { not: null },
            claimedAt: { lt: staleBefore },
          },
        ],
      },
      data: {
        claimToken,
        claimedAt: now,
        cleanupAttempts: { increment: 1 },
      },
    });

    if (claimed.count !== 1) return 0;

    try {
      const attempt = await prisma.artifactUploadAttempt.findUniqueOrThrow({
        where: { id: candidate.id },
      });

      const expectedPrefix = createArtifactPrefix(
        attempt.projectId,
        attempt.deploymentId,
        attempt.processingToken,
      );

      if (attempt.artifactBucket !== r2BucketName || attempt.artifactPrefix !== expectedPrefix) {
        throw new ProtectedArtifactError('Cleanup refused: unexpected artifact bucket or prefix.');
      }

      async function verifyOwnershipAndReferences(): Promise<void> {
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT "id"
            FROM "Deployment"
            WHERE "id" = ${attempt.deploymentId}
            FOR UPDATE
          `;

          const current = await tx.artifactUploadAttempt.findUnique({
            where: { id: attempt.id },
          });

          if (
            !current ||
            current.claimToken !== claimToken ||
            !current.claimedAt ||
            current.claimedAt.getTime() <= Date.now() - CLAIM_LEASE_MS ||
            (current.status !== 'CLEANUP_PENDING' && current.status !== 'CLEANED') ||
            current.artifactBucket !== attempt.artifactBucket ||
            current.artifactPrefix !== attempt.artifactPrefix
          ) {
            throw new Error('Artifact cleanup claim was lost or changed.');
          }

          const deployment = await tx.deployment.findUnique({
            where: { id: attempt.deploymentId },
            select: {
              projectId: true,
              status: true,
              processingToken: true,
            },
          });

          if (!deployment || deployment.projectId !== attempt.projectId) {
            throw new ProtectedArtifactError(
              'Cleanup refused: deployment ownership cannot be verified.',
            );
          }

          const terminal =
            deployment.status === 'READY' ||
            deployment.status === 'FAILED' ||
            deployment.status === 'CANCELLED';

          if (!terminal && deployment.processingToken === attempt.processingToken) {
            throw new ProtectedArtifactError(
              'Cleanup refused: this execution still owns the deployment.',
            );
          }

          const reference = await tx.deployment.findFirst({
            where: {
              artifactBucket: attempt.artifactBucket,
              artifactPrefix: attempt.artifactPrefix,
            },
            select: { id: true },
          });

          if (reference) {
            throw new ProtectedArtifactError(
              'Cleanup refused: a deployment references these artifacts.',
            );
          }

          await tx.artifactUploadAttempt.update({
            where: { id: attempt.id },
            data: { claimedAt: new Date() },
          });
        });
      }

      async function verifyPublicRoute(): Promise<void> {
        const project = await prisma.project.findUnique({
          where: { id: attempt.projectId },
          select: { subdomain: true },
        });

        // Do not infer that storage is unused from missing project data.
        if (!project?.subdomain) {
          throw new ProtectedArtifactError(
            'Cleanup refused: the project delivery route cannot be identified.',
          );
        }

        const stored = await storage.readDeliveryRoute(project.subdomain);

        if (!stored) return;

        const record = stored.record;

        if (isDisabledDeliveryRoute(record)) {
          if (record.projectId !== attempt.projectId) {
            throw new ProtectedArtifactError(
              'Cleanup refused: disabled route belongs to another project.',
            );
          }

          return;
        }

        // Accept the legacy version/prefix format supported by routing.
        if (
          typeof record !== 'object' ||
          record === null ||
          !('version' in record) ||
          record.version !== 1 ||
          !('artifactPrefix' in record) ||
          typeof record.artifactPrefix !== 'string'
        ) {
          throw new ProtectedArtifactError('Cleanup refused: invalid delivery route.');
        }

        createArtifactObjectKey(record.artifactPrefix, 'index.html');

        if (
          !record.artifactPrefix.startsWith(`projects/${attempt.projectId}/deployments/`) ||
          ('projectId' in record && record.projectId !== attempt.projectId)
        ) {
          throw new ProtectedArtifactError(
            'Cleanup refused: delivery route belongs to another project.',
          );
        }

        if (record.artifactPrefix === attempt.artifactPrefix) {
          throw new ProtectedArtifactError('Cleanup refused: these artifacts are publicly routed.');
        }
      }

      await verifyOwnershipAndReferences();
      await verifyPublicRoute();

      const listed = await storage.listObjects(
        attempt.artifactBucket,
        attempt.artifactPrefix,
        PAGE_SIZE,
      );
      const keys: string[] = [];

      for (const object of listed.Contents ?? []) {
        if (
          typeof object.Key !== 'string' ||
          !object.Key.startsWith(attempt.artifactPrefix) ||
          object.Key.length <= attempt.artifactPrefix.length
        ) {
          throw new ProtectedArtifactError(
            'Cleanup refused: listing returned an unexpected object key.',
          );
        }

        keys.push(object.Key);
      }

      if (keys.length === 0 && listed.IsTruncated) {
        throw new Error('Artifact listing was truncated without returning keys.');
      }

      // Recheck after network reads, immediately before deletion.
      await verifyPublicRoute();
      await verifyOwnershipAndReferences();

      if (keys.length > 0) {
        const deleted = await storage.deleteObjects(attempt.artifactBucket, keys);

        if (deleted.Errors?.length) {
          throw new Error(`Storage failed to delete ${deleted.Errors.length} artifact object(s).`);
        }
      }

      // A successful delete response is not an empty-prefix observation.
      // Schedule another pass after deleting any objects.
      const observedEmpty = keys.length === 0;

      const marked = await prisma.artifactUploadAttempt.updateMany({
        where: {
          id: attempt.id,
          claimToken,
          status: { in: [...cleanupStatuses()] },
        },
        data: {
          status: observedEmpty ? 'CLEANED' : 'CLEANUP_PENDING',
          cleanedAt: observedEmpty ? new Date() : null,
          cleanupAfter: new Date(
            Date.now() + (observedEmpty ? CLEANED_RECHECK_MS : RETRY_DELAY_MS),
          ),
          claimToken: null,
          claimedAt: null,
          lastError: null,
        },
      });

      if (marked.count !== 1) {
        console.warn('Artifact cleanup completed after its claim changed.', {
          attemptId: attempt.id,
        });
        return 0;
      }

      console.log('Artifact cleanup pass completed.', {
        attemptId: attempt.id,
        deletedObjects: keys.length,
        observedEmpty,
      });

      return 1;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown artifact cleanup error';

      await prisma.artifactUploadAttempt.updateMany({
        where: {
          id: candidate.id,
          claimToken,
        },
        data: {
          claimToken: null,
          claimedAt: null,
          cleanupAfter: new Date(
            Date.now() +
              (error instanceof ProtectedArtifactError ? PROTECTED_RECHECK_MS : RETRY_DELAY_MS),
          ),
          lastError: message.slice(0, 2_000),
        },
      });

      console.error('Artifact cleanup deferred.', {
        attemptId: candidate.id,
        error: message,
      });

      return 0;
    }
  } finally {
    running = false;
  }
}
