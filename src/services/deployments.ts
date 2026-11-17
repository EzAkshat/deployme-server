import { prisma } from '../config/database.js';
import { getProductionBranchCommitSha } from './github-app.js';
import {
  canDeployToProject,
  ProjectAuthorizationError,
  requireProjectPermission,
} from './project-authorization.js';
import { captureDeploymentBuildSettings } from './deployment-build-settings.js';
import {
  resourceUsageSelect,
  withDeploymentResourceSummary,
} from './deployment-resource-summary.js';
import { enforceProjectDeploymentQuota } from './deployment-quota.js';
import { lockTeamForMutation } from './team-lock.js';
import { lockActiveAccount } from './account-availability.js';

export class DeploymentServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeploymentServiceError';
  }
}

/**
 * Creates a deployment and its outbox event atomically.
 *
 * The dispatcher will enqueue the outbox event in BullMQ later.
 * This request does not build or publish the project.
 */
export async function requestDeployment(userId: number, projectId: string) {
  const canDeploy = await canDeployToProject(userId, projectId);

  if (!canDeploy) {
    throw new ProjectAuthorizationError(
      'PROJECT_DEPLOY_DENIED',
      'The project was not found or you do not have permission to deploy it.',
    );
  }
  let commitSha: string;

  try {
    commitSha = await getProductionBranchCommitSha(projectId);
  } catch (error) {
    throw new DeploymentServiceError(
      'GITHUB_COMMIT_RESOLUTION_FAILED',
      'Could not resolve the production branch commit. Check the GitHub repository connection and try again.',
    );
  }

  return prisma.$transaction(async (tx) => {
    const initial = await tx.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });

    if (!initial) {
      throw new DeploymentServiceError(
        'PROJECT_NOT_FOUND',
        'The project was not found or is archived.',
      );
    }

    if (initial.teamId !== null) {
      await lockTeamForMutation(tx, initial.teamId);
    }

    // Recheck current membership and deployment permission after locking.
    const project = await tx.project.findFirst({
      where: {
        id: projectId,
        archivedAt: null,
        OR: [
          {
            ownerUserId: userId,
            teamId: null,
          },
          {
            ownerUserId: null,
            teamId: initial.teamId,
            team: {
              memberships: {
                some: { userId },
              },
            },
            shares: {
              some: {
                userId,
                canDeploy: true,
              },
            },
          },
        ],
      },
      select: { id: true },
    });

    if (!project) {
      throw new ProjectAuthorizationError(
        'PROJECT_DEPLOY_DENIED',
        'The project was not found or you do not have permission to deploy it.',
      );
    }

    await enforceProjectDeploymentQuota(tx, project.id);
    // Personal owners were checked by quota enforcement.
    // Team deployments also need the requesting member checked.
    if (initial.teamId !== null) {
      await lockActiveAccount(tx, userId);
    }
    const deployment = await tx.deployment.create({
      data: {
        projectId: project.id,
        commitSha,
        status: 'PENDING',
        buildSettings: await captureDeploymentBuildSettings(tx, project.id),
      },
      select: {
        id: true,
        projectId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await tx.deploymentOutbox.create({
      data: {
        deploymentId: deployment.id,
        eventType: 'DEPLOYMENT_REQUESTED',
        payload: {
          deploymentId: deployment.id,
          projectId: deployment.projectId,
          commitSha,
        },
      },
    });

    return deployment;
  });
}

function withDeploymentMetrics<
  T extends {
    buildStartedAt: Date | null;
    buildFinishedAt: Date | null;
  },
>(deployment: T) {
  return {
    ...deployment,
    buildElapsedMs:
      deployment.buildStartedAt !== null && deployment.buildFinishedAt !== null
        ? Math.max(0, deployment.buildFinishedAt.getTime() - deployment.buildStartedAt.getTime())
        : null,
  };
}

export async function listProjectDeployments(
  userId: number,
  projectId: string,
  options: { limit?: number; cursor?: string } = {},
) {
  await requireProjectPermission(userId, projectId, 'VIEW');

  const limit = options.limit ?? 20;

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (options.cursor !== undefined && (options.cursor.length === 0 || options.cursor.length > 128))
  ) {
    throw new DeploymentServiceError(
      'INVALID_PAGINATION',
      'Provide a limit from 1 to 100 and a valid cursor.',
    );
  }

  const cursorDeployment =
    options.cursor === undefined
      ? null
      : await prisma.deployment.findFirst({
          where: {
            id: options.cursor,
            projectId,
          },
          select: {
            id: true,
            createdAt: true,
          },
        });

  if (options.cursor !== undefined && !cursorDeployment) {
    throw new DeploymentServiceError(
      'INVALID_PAGINATION',
      'The deployment cursor is invalid for this project.',
    );
  }

  const rows = await prisma.deployment.findMany({
    where: {
      projectId,
      ...(cursorDeployment
        ? {
            OR: [
              { createdAt: { lt: cursorDeployment.createdAt } },
              {
                createdAt: cursorDeployment.createdAt,
                id: { lt: cursorDeployment.id },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      commitSha: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      publishedAt: true,
      buildStartedAt: true,
      buildFinishedAt: true,
      artifactFileCount: true,
      artifactSizeBytes: true,
      processingAttempt: true,
      resourceUsage: {
        select: resourceUsageSelect,
      },
    },
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const lastDeployment = page[page.length - 1];

  return {
    deployments: page.map((deployment) =>
      withDeploymentMetrics(withDeploymentResourceSummary(deployment)),
    ),
    nextCursor: hasMore && lastDeployment ? lastDeployment.id : null,
  };
}

export async function getProjectDeployment(
  userId: number,
  projectId: string,
  deploymentId: string,
) {
  await requireProjectPermission(userId, projectId, 'VIEW');

  const deployment = await prisma.deployment.findFirst({
    where: { id: deploymentId, projectId },
    select: {
      id: true,
      commitSha: true,
      status: true,
      failureReason: true,
      createdAt: true,
      updatedAt: true,
      publishedAt: true,
      buildSettings: true,
      buildStartedAt: true,
      buildFinishedAt: true,
      artifactFileCount: true,
      artifactSizeBytes: true,
      processingAttempt: true,
      resourceUsage: {
        select: resourceUsageSelect,
      },
    },
  });
  return deployment ? withDeploymentMetrics(withDeploymentResourceSummary(deployment)) : null;
}
