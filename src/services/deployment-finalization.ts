import { prisma } from '../config/database.js';

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

export async function finalizeDeployment(
  input: FinalizeDeploymentInput,
): Promise<void> {
  const {
    deploymentId,
    projectId,
    processingToken,
    published,
    renewQueueLock,
  } = input;

  await prisma.$transaction(async (tx) => {
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
      throw new Error(
        'Deployment queue ownership was lost before finalization',
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