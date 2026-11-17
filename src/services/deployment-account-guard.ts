import type { Prisma } from '../generated/prisma/client.js';

export class DeploymentAccountSuspendedError extends Error {
  constructor() {
    super('Deployment stopped because the personal project owner is suspended.');
    this.name = 'DeploymentAccountSuspendedError';
  }
}

// Acquire the owner lock before acquiring the deployment lock.
// Suspension must use the same User row lock.
export async function lockDeploymentOwner(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<boolean> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: {
      teamId: true,
      ownerUserId: true,
    },
  });

  if (!project) {
    throw new Error('Deployment project no longer exists.');
  }

  if (project.teamId !== null) {
    if (project.ownerUserId !== null) {
      throw new Error('Deployment project has conflicting ownership.');
    }

    return true;
  }

  if (project.ownerUserId === null) {
    throw new Error('Deployment project has no owner.');
  }

  await tx.$queryRaw`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${project.ownerUserId}
    FOR UPDATE
  `;

  const owner = await tx.user.findUnique({
    where: { id: project.ownerUserId },
    select: { suspendedAt: true },
  });

  if (!owner) {
    throw new Error('Deployment project owner no longer exists.');
  }

  return owner.suspendedAt === null;
}
