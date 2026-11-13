import type { Prisma } from '../generated/prisma/client.js';

export const MAX_UNFINISHED_DEPLOYMENTS = 5;

export type DeploymentQuotaScope =
  | { kind: 'personal'; userId: number }
  | { kind: 'team'; teamId: string };

export class DeploymentQuotaError extends Error {
  readonly code = 'DEPLOYMENT_QUOTA_EXCEEDED';

  constructor(
    public readonly activeCount: number,
    public readonly limit: number,
  ) {
    super(
      `This account or team already has ${activeCount} unfinished deployments. ` +
        `The limit is ${limit}. Wait for a deployment to finish and retry.`,
    );
    this.name = 'DeploymentQuotaError';
  }
}

export async function getProjectDeploymentQuotaScope(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<DeploymentQuotaScope> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: {
      ownerUserId: true,
      teamId: true,
    },
  });

  if (
    project?.ownerUserId !== null &&
    project?.ownerUserId !== undefined &&
    project.teamId === null
  ) {
    return { kind: 'personal', userId: project.ownerUserId };
  }

  if (
    project?.teamId !== null &&
    project?.teamId !== undefined &&
    project.ownerUserId === null
  ) {
    return { kind: 'team', teamId: project.teamId };
  }

  throw new Error('Deployment project has no valid quota owner');
}

/**
 * Acquire before counting or creating deployments.
 * The write lock remains held until the transaction ends.
 *
 * A real update is intentional: Serializable transactions with an
 * outdated snapshot must retry instead of using an outdated count.
 */
export async function lockDeploymentQuota(
  tx: Prisma.TransactionClient,
  scope: DeploymentQuotaScope,
): Promise<void> {
  const scopeKey =
    scope.kind === 'personal'
      ? `personal:${scope.userId}`
      : `team:${scope.teamId}`;

  await tx.deploymentQuotaLock.upsert({
    where: { scopeKey },
    create: {
      scopeKey,
      revision: 1n,
    },
    update: {
      revision: { increment: 1n },
    },
    select: { scopeKey: true },
  });
}

/**
 * Call only after lockDeploymentQuota(), in the same transaction
 * that creates the deployment.
 */
export async function assertDeploymentQuotaAvailable(
  tx: Prisma.TransactionClient,
  scope: DeploymentQuotaScope,
): Promise<void> {
  const activeCount = await tx.deployment.count({
    where: {
      status: { in: ['PENDING', 'QUEUED', 'BUILDING'] },
      project:
        scope.kind === 'personal'
          ? {
              ownerUserId: scope.userId,
              teamId: null,
            }
          : {
              teamId: scope.teamId,
              ownerUserId: null,
            },
    },
  });

  // Archived projects are intentionally included while their
  // deployments are still unfinished.
  if (activeCount >= MAX_UNFINISHED_DEPLOYMENTS) {
    throw new DeploymentQuotaError(
      activeCount,
      MAX_UNFINISHED_DEPLOYMENTS,
    );
  }
}

export async function enforceProjectDeploymentQuota(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<void> {
  const scope = await getProjectDeploymentQuotaScope(tx, projectId);

  await lockDeploymentQuota(tx, scope);
  await assertDeploymentQuotaAvailable(tx, scope);
}