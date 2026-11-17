import { prisma } from '../config/database.js';
import { createArtifactPrefix } from './artifact-object.js';
import {
  DeploymentAccountSuspendedError,
  lockDeploymentOwner,
} from './deployment-account-guard.js';

interface FinalizeDeploymentInput {
  deploymentId: string;
  projectId: string;
  processingToken: string;
  published: {
    artifactBucket: string;
    artifactPrefix: string;
    fileCount: number;
    totalFileBytes: number;
  };
  renewQueueLock: () => Promise<number>;
}

export async function finalizeDeployment(input: FinalizeDeploymentInput): Promise<void> {
  const { deploymentId, projectId, processingToken, published, renewQueueLock } = input;

  const expectedPrefix = createArtifactPrefix(projectId, deploymentId, processingToken);

  if (published.artifactPrefix !== expectedPrefix) {
    throw new Error('Cannot finalize deployment: artifact prefix does not match this execution.');
  }

  await prisma.$transaction(async (tx) => {
    if (!(await lockDeploymentOwner(tx, projectId))) {
      throw new DeploymentAccountSuspendedError();
    }
    // Keep lock ordering consistent with registration, claims and recovery.
    await tx.$queryRaw`
      SELECT "id"
      FROM "Deployment"
      WHERE "id" = ${deploymentId}
      FOR UPDATE
    `;

    const finishedAt = new Date();

    const completed = await tx.deployment.updateMany({
      where: {
        id: deploymentId,
        projectId,
        status: 'BUILDING',
        processingToken,
      },
      data: {
        status: 'READY',
        failureReason: null,
        artifactBucket: published.artifactBucket,
        artifactPrefix: published.artifactPrefix,
        artifactFileCount: published.fileCount,
        artifactSizeBytes: published.totalFileBytes,
        publishedAt: finishedAt,
        buildFinishedAt: finishedAt,
        processingToken: null,
        processingStartedAt: null,
      },
    });

    if (completed.count !== 1) {
      throw new Error(
        'Artifacts uploaded, but deployment could not be finalized: processing ownership was lost.',
      );
    }

    if ((await renewQueueLock()) !== 1) {
      throw new Error('Deployment queue ownership was lost before finalization');
    }

    const adopted = await tx.artifactUploadAttempt.updateMany({
      where: {
        deploymentId,
        projectId,
        processingToken,
        artifactBucket: published.artifactBucket,
        artifactPrefix: published.artifactPrefix,
        status: 'UPLOADING',
        claimToken: null,
        claimedAt: null,
      },
      data: {
        status: 'ADOPTED',
        adoptedAt: finishedAt,
        cleanupAfter: null,
        cleanedAt: null,
        lastError: null,
      },
    });

    if (adopted.count !== 1) {
      throw new Error(
        'Cannot finalize deployment: its artifact upload attempt is missing or no longer eligible for adoption.',
      );
    }

    await tx.deploymentOutbox.create({
      data: {
        deploymentId,
        eventType: 'DEPLOYMENT_ROUTING_REQUESTED',
        payload: {
          deploymentId,
          projectId,
        },
      },
    });
  });
}
