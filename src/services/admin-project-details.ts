import { prisma } from '../config/database.js';
import {
  resourceUsageSelect,
  withDeploymentResourceSummary,
} from './deployment-resource-summary.js';

const PAGE_SIZE = 25;

export class AdminProjectDetailsError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminProjectDetailsError';
  }
}

export async function getAdminProjectDetails(
  projectId: string,
  input: { after?: string } = {},
) {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        slug: true,
        subdomain: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
        ownerUser: {
          select: {
            id: true,
            username: true,
            suspendedAt: true,
          },
        },
        team: {
          select: {
            id: true,
            name: true,
          },
        },
        _count: {
          select: { deployments: true },
        },
      },
    });

    if (!project) {
      throw new AdminProjectDetailsError(404, 'Project not found.');
    }

    const cursor = input.after
      ? await tx.deployment.findFirst({
          where: {
            id: input.after,
            projectId,
          },
          select: {
            id: true,
            createdAt: true,
          },
        })
      : null;

    if (input.after && !cursor) {
      throw new AdminProjectDetailsError(
        400,
        'Invalid deployment pagination cursor.',
      );
    }

    const rows = await tx.deployment.findMany({
      where: {
        projectId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                {
                  createdAt: cursor.createdAt,
                  id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      select: {
        id: true,
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

    // Publication history is independent of the requested history page.
    const lastRecordedPublication = await tx.deployment.findFirst({
      where: {
        projectId,
        publishedAt: { not: null },
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        publishedAt: true,
      },
    });

    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    const { _count, ...projectDetails } = project;

    return {
      project: {
        ...projectDetails,
        deploymentCount: _count.deployments,
        lastRecordedPublication,
      },
      deployments: page.map((deployment) => ({
        ...withDeploymentResourceSummary(deployment),
        buildDurationMs:
          deployment.buildStartedAt !== null &&
          deployment.buildFinishedAt !== null
            ? Math.max(
                0,
                deployment.buildFinishedAt.getTime() -
                  deployment.buildStartedAt.getTime(),
              )
            : null,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }, {
    isolationLevel: 'RepeatableRead',
  });
}