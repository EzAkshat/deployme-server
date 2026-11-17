import { prisma } from '../config/database.js';
import { r2BucketName } from '../config/r2.js';
import { createArtifactPrefix } from './artifact-object.js';

const BATCH_SIZE = 25;

// This delay reduces overlap with requests still finishing after ownership
// loss. It is not proof that all uploads have stopped; deletion must also
// perform delayed follow-up sweeps.
const CLEANUP_DELAY_MS = 15 * 60_000;

let scanAfterId: string | undefined;
let scanning = false;

export async function reconcileArtifactUploadAttempts(): Promise<number> {
  if (scanning) return 0;
  scanning = true;

  try {
    const candidates = await prisma.artifactUploadAttempt.findMany({
      where: {
        status: 'UPLOADING',
        ...(scanAfterId ? { id: { gt: scanAfterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true,
        deploymentId: true,
      },
    });

    const last = candidates.at(-1);
    scanAfterId = candidates.length === BATCH_SIZE && last ? last.id : undefined;

    let reconciled = 0;

    for (const candidate of candidates) {
      try {
        const changed = await prisma.$transaction(async (tx) => {
          // Same lock order as registration and finalization:
          // deployment first, upload-attempt row second.
          await tx.$queryRaw`
            SELECT "id"
            FROM "Deployment"
            WHERE "id" = ${candidate.deploymentId}
            FOR UPDATE
          `;

          const attempt = await tx.artifactUploadAttempt.findUnique({
            where: { id: candidate.id },
          });

          if (
            !attempt ||
            attempt.status !== 'UPLOADING' ||
            attempt.claimToken !== null ||
            attempt.claimedAt !== null
          ) {
            return false;
          }

          const expectedPrefix = createArtifactPrefix(
            attempt.projectId,
            attempt.deploymentId,
            attempt.processingToken,
          );

          if (
            attempt.artifactBucket !== r2BucketName ||
            attempt.artifactPrefix !== expectedPrefix
          ) {
            throw new Error('Upload attempt has an unexpected artifact location');
          }

          const deployment = await tx.deployment.findUnique({
            where: { id: attempt.deploymentId },
            select: {
              projectId: true,
              status: true,
              processingToken: true,
            },
          });

          // Missing deployment records require a separate reconciliation
          // policy. Do not infer abandonment from absence alone.
          if (!deployment) return false;

          if (deployment.projectId !== attempt.projectId) {
            throw new Error('Upload attempt belongs to a different project');
          }

          // Preserve any prefix already recorded on a deployment,
          // regardless of that deployment's current status.
          const reference = await tx.deployment.findFirst({
            where: {
              artifactBucket: attempt.artifactBucket,
              artifactPrefix: attempt.artifactPrefix,
            },
            select: { id: true },
          });

          if (reference) return false;

          const terminal =
            deployment.status === 'READY' ||
            deployment.status === 'FAILED' ||
            deployment.status === 'CANCELLED';

          // An elapsed timer does not revoke execution ownership.
          if (!terminal && deployment.processingToken === attempt.processingToken) {
            return false;
          }

          const result = await tx.artifactUploadAttempt.updateMany({
            where: {
              id: attempt.id,
              status: 'UPLOADING',
              claimToken: null,
              claimedAt: null,
            },
            data: {
              status: 'CLEANUP_PENDING',
              cleanupAfter: new Date(Date.now() + CLEANUP_DELAY_MS),
              cleanedAt: null,
              lastError: null,
            },
          });

          return result.count === 1;
        });

        if (changed) reconciled += 1;
      } catch (error: unknown) {
        console.error('Artifact upload reconciliation failed.', {
          attemptId: candidate.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return reconciled;
  } finally {
    scanning = false;
  }
}
