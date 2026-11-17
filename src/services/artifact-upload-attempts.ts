import { prisma } from '../config/database.js';
import { r2BucketName } from '../config/r2.js';
import { createArtifactPrefix } from './artifact-object.js';

interface RegisterArtifactUploadInput {
  deploymentId: string;
  projectId: string;
  processingToken: string;
}

export async function registerArtifactUploadAttempt(
  input: RegisterArtifactUploadInput,
): Promise<void> {
  const artifactPrefix = createArtifactPrefix(
    input.projectId,
    input.deploymentId,
    input.processingToken,
  );

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "Deployment"
      WHERE "id" = ${input.deploymentId}
      FOR UPDATE
    `;

    const deployment = await tx.deployment.findFirst({
      where: {
        id: input.deploymentId,
        projectId: input.projectId,
        status: 'BUILDING',
        processingToken: input.processingToken,
      },
      select: { id: true },
    });

    if (!deployment) {
      throw new Error('Cannot publish artifacts: deployment execution ownership was lost.');
    }

    // Each execution may begin publishing only once. A queue retry must
    // obtain a fresh processing token and therefore a new prefix.
    await tx.artifactUploadAttempt.create({
      data: {
        deploymentId: input.deploymentId,
        projectId: input.projectId,
        processingToken: input.processingToken,
        artifactBucket: r2BucketName,
        artifactPrefix,
      },
    });
  });
}
