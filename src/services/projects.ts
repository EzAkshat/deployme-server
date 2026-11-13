import { prisma } from '../config/database.js';
import {
  ProjectAuthorizationError,
  canViewProject,
  requireProjectPermission,
} from './project-authorization.js';
import { listInstallationRepositories, syncGitHubInstallation } from './github-app.js';
import {
  normalizeProjectSubdomain,
  createRepositorySubdomainCandidate,
} from './project-subdomain.js';
import { Prisma } from '../generated/prisma/client.js';
import { z } from 'zod';
import { getGitHubUserAccessToken, GitHubUserTokenError } from './github-user-token.js';
import { r2BucketName } from '../config/r2.js';
import { readDeliveryRoute } from './delivery-route-storage.js';
import { posix } from 'node:path';
import {
  resourceUsageSelect,
  withDeploymentResourceSummary,
} from './deployment-resource-summary.js';
import { lockTeamForMutation } from './team-lock.js';

export class ProjectServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectServiceError';
  }
}

export interface CreateProjectInput {
  teamId?: string;
  name: string;
  slug: string;
  rootDirectory?: string;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  spaFallback?: boolean;
  subdomain?: string;
}

/** Creates a personal project or a project in a team the user manages. */
export async function createProject(
  userId: number,
  input: CreateProjectInput,
  db: Prisma.TransactionClient = prisma,
) {
  if (input.teamId !== undefined) {
    const membership = await db.teamMembership.findUnique({
      where: {
        teamId_userId: {
          teamId: input.teamId,
          userId,
        },
      },
      select: {
        role: true,
      },
    });

    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'MANAGER')) {
      throw new ProjectServiceError(
        'PROJECT_CREATE_DENIED',
        'The team was not found or you cannot create projects in it.',
      );
    }
  }

  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();

  if (!name || !slug) {
    throw new ProjectServiceError('INVALID_PROJECT_INPUT', 'Project name and slug are required.');
  }
  const subdomain =
    input.subdomain === undefined ? null : normalizeProjectSubdomain(input.subdomain);

  if (input.subdomain !== undefined && subdomain === null) {
    throw new ProjectServiceError(
      'INVALID_PROJECT_INPUT',
      'Choose a subdomain of 1–63 lowercase letters, numbers, or single hyphens. Platform names are reserved.',
    );
  }

  return db.project.create({
    data: {
      ...(input.teamId === undefined ? { ownerUserId: userId } : { teamId: input.teamId }),
      name,
      slug,
      subdomain,
      ...(input.rootDirectory !== undefined && {
        rootDirectory: input.rootDirectory.trim(),
      }),
      ...(input.installCommand !== undefined && {
        installCommand: input.installCommand.trim(),
      }),
      ...(input.buildCommand !== undefined && {
        buildCommand: input.buildCommand.trim(),
      }),
      ...(input.spaFallback !== undefined && { spaFallback: input.spaFallback }),
      ...(input.outputDirectory !== undefined && {
        outputDirectory: input.outputDirectory.trim(),
      }),
    },
    select: {
      id: true,
      teamId: true,
      ownerUserId: true,
      name: true,
      slug: true,
      rootDirectory: true,
      installCommand: true,
      buildCommand: true,
      outputDirectory: true,
      spaFallback: true,
      createdAt: true,
      updatedAt: true,
      archivedAt: true,
      subdomain: true,
    },
  });
}
/** Lists the signed-in user's active personal projects, newest first. */
export async function listPersonalProjects(userId: number) {
  return prisma.project.findMany({
    where: {
      ownerUserId: userId,
      archivedAt: null,
    },
    select: {
      id: true,
      ownerUserId: true,
      teamId: true,
      name: true,
      slug: true,
      subdomain: true,
      rootDirectory: true,
      installCommand: true,
      buildCommand: true,
      outputDirectory: true,
      spaFallback: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

/**
 * Lists projects visible to the user within a team.
 *
 * Owners and managers see every active project.
 * Members see only projects explicitly shared with them
 * where canView=true.
 */
export async function listTeamProjects(userId: number, teamId: string) {
  const membership = await prisma.teamMembership.findUnique({
    where: {
      teamId_userId: {
        teamId,
        userId,
      },
    },
    select: {
      role: true,
    },
  });

  if (!membership) {
    throw new ProjectServiceError(
      'TEAM_ACCESS_DENIED',
      'The team was not found or you are not a member.',
    );
  }

  const isManager = membership.role === 'OWNER' || membership.role === 'MANAGER';

  const projects = await prisma.project.findMany({
    where: {
      teamId,
      archivedAt: null,
      ...(isManager
        ? {}
        : {
            shares: {
              some: {
                userId,
                canView: true,
              },
            },
          }),
    },
    select: {
      id: true,
      teamId: true,
      ownerUserId: true,
      name: true,
      slug: true,
      rootDirectory: true,
      installCommand: true,
      buildCommand: true,
      outputDirectory: true,
      spaFallback: true,
      createdAt: true,
      updatedAt: true,
      archivedAt: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return projects;
}

async function getProjectDelivery(projectId: string, subdomain: string | null) {
  const url = subdomain ? `https://${subdomain}.deployme.in` : null;

  if (!subdomain) {
    return {
      status: 'not_configured' as const,
      url: null,
      liveDeployment: null,
    };
  }

  try {
    const stored = await readDeliveryRoute(subdomain);

    if (!stored) {
      return {
        status: 'not_published' as const,
        url,
        liveDeployment: null,
      };
    }

    const record = stored.record;

    if (
      typeof record !== 'object' ||
      record === null ||
      !('version' in record) ||
      record.version !== 1 ||
      !('artifactPrefix' in record) ||
      typeof record.artifactPrefix !== 'string' ||
      ('projectId' in record && record.projectId !== projectId) ||
      ('spaFallback' in record && typeof record.spaFallback !== 'boolean')
    ) {
      throw new Error('Invalid project delivery route');
    }

    const deployment = await prisma.deployment.findFirst({
      where: {
        projectId,
        status: 'READY',
        artifactBucket: r2BucketName,
        artifactPrefix: record.artifactPrefix,
      },
      select: {
        id: true,
        commitSha: true,
        createdAt: true,
        artifactFileCount: true,
        artifactSizeBytes: true,
      },
    });

    if (
      !deployment ||
      !record.artifactPrefix.startsWith(`projects/${projectId}/deployments/${deployment.id}/`) ||
      ('deploymentId' in record && record.deploymentId !== deployment.id)
    ) {
      throw new Error('Delivery route does not match this project deployment');
    }

    return {
      status: 'published' as const,
      url,
      liveDeployment: deployment,
    };
  } catch {
    // A failed lookup must not make the dashboard claim the site is offline.
    console.error('Could not determine project delivery status.', { projectId });

    return {
      status: 'unknown' as const,
      url,
      liveDeployment: null,
    };
  }
}
/**
 * Retrieves one project only if the user can view it.
 */
export async function getProject(userId: number, projectId: string) {
  const allowed = await canViewProject(userId, projectId);

  if (!allowed) {
    throw new ProjectAuthorizationError(
      'PROJECT_ACCESS_DENIED',
      'The project was not found or you do not have permission to view it.',
    );
  }

  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      archivedAt: null,
    },
    select: {
      id: true,
      teamId: true,
      ownerUserId: true,
      name: true,
      slug: true,
      subdomain: true,
      rootDirectory: true,
      installCommand: true,
      buildCommand: true,
      outputDirectory: true,
      spaFallback: true,
      createdAt: true,
      updatedAt: true,
      archivedAt: true,
    },
  });

  if (!project) {
    throw new ProjectAuthorizationError(
      'PROJECT_ACCESS_DENIED',
      'The project was not found or you do not have permission to view it.',
    );
  }

  const delivery = await getProjectDelivery(project.id, project.subdomain);

  return {
    ...project,
    delivery,
  };
}
export async function getProjectOverview(userId: number, projectId: string) {
  // Checks access and excludes archived projects before reading deployments.
  const project = await getProject(userId, projectId);

  const deployments = await prisma.deployment.findMany({
    where: { projectId: project.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
    select: {
      id: true,
      commitSha: true,
      status: true,
      failureReason: true,
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

  const countsByStatus: Record<string, number> = {
    PENDING: 0,
    QUEUED: 0,
    BUILDING: 0,
    READY: 0,
    FAILED: 0,
    CANCELLED: 0,
  };

  const recentDeployments = deployments.map((deployment) => {
    countsByStatus[deployment.status] = (countsByStatus[deployment.status] ?? 0) + 1;

    return {
      ...withDeploymentResourceSummary(deployment),
      buildElapsedMs:
        deployment.buildStartedAt !== null && deployment.buildFinishedAt !== null
          ? Math.max(0, deployment.buildFinishedAt.getTime() - deployment.buildStartedAt.getTime())
          : null,
    };
  });

  return {
    project,
    latestDeployment: recentDeployments[0] ?? null,
    recentDeploymentSummary: {
      scope: 'latest_20' as const,
      limit: 20,
      count: recentDeployments.length,
      countsByStatus,
    },
    recentDeployments,
  };
}
export interface SetProjectShareInput {
  projectId: string;
  targetUserId: number;
  canView: boolean;
  canDeploy: boolean;
  canManage: boolean;
}

/**
 * Creates or updates a user's explicit permissions for a project.
 * Only team owners and managers may change project shares.
 */
export async function setProjectShare(actorUserId: number, input: SetProjectShareInput) {
  return prisma.$transaction(async (tx) => {
    const initial = await tx.project.findUnique({
      where: { id: input.projectId },
      select: { teamId: true },
    });

    if (!initial?.teamId) {
      throw new ProjectServiceError(
        'PROJECT_MANAGE_DENIED',
        'The project was not found or you cannot manage its sharing permissions.',
      );
    }

    await lockTeamForMutation(tx, initial.teamId);

    // Recheck after acquiring the team lock.
    const project = await tx.project.findFirst({
      where: {
        id: input.projectId,
        teamId: initial.teamId,
        ownerUserId: null,
        archivedAt: null,
        team: {
          memberships: {
            some: {
              userId: actorUserId,
              role: { in: ['OWNER', 'MANAGER'] },
            },
          },
        },
      },
      select: { id: true, teamId: true },
    });

    if (!project) {
      throw new ProjectServiceError(
        'PROJECT_MANAGE_DENIED',
        'The project was not found or you cannot manage its sharing permissions.',
      );
    }

    const target = await tx.teamMembership.findUnique({
      where: {
        teamId_userId: {
          teamId: initial.teamId,
          userId: input.targetUserId,
        },
      },
      select: { id: true },
    });

    if (!target) {
      throw new ProjectServiceError(
        'TARGET_NOT_TEAM_MEMBER',
        'Project access can only be granted to a member of the project team.',
      );
    }

    return tx.projectShare.upsert({
      where: {
        projectId_userId: {
          projectId: input.projectId,
          userId: input.targetUserId,
        },
      },
      create: {
        projectId: input.projectId,
        userId: input.targetUserId,
        grantedByUserId: actorUserId,
        canView: input.canView,
        canDeploy: input.canDeploy,
        canManage: input.canManage,
      },
      update: {
        grantedByUserId: actorUserId,
        canView: input.canView,
        canDeploy: input.canDeploy,
        canManage: input.canManage,
      },
      select: {
        projectId: true,
        userId: true,
        grantedByUserId: true,
        canView: true,
        canDeploy: true,
        canManage: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });
}

export async function revokeProjectShare(
  actorUserId: number,
  projectId: string,
  targetUserId: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const initial = await tx.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });

    if (!initial?.teamId) {
      throw new ProjectServiceError(
        'PROJECT_MANAGE_DENIED',
        'The project was not found or you cannot manage its sharing permissions.',
      );
    }

    await lockTeamForMutation(tx, initial.teamId);

    const project = await tx.project.findFirst({
      where: {
        id: projectId,
        teamId: initial.teamId,
        ownerUserId: null,
        archivedAt: null,
        team: {
          memberships: {
            some: {
              userId: actorUserId,
              role: { in: ['OWNER', 'MANAGER'] },
            },
          },
        },
      },
      select: { id: true },
    });

    if (!project) {
      throw new ProjectServiceError(
        'PROJECT_MANAGE_DENIED',
        'The project was not found or you cannot manage its sharing permissions.',
      );
    }

    const result = await tx.projectShare.deleteMany({
      where: { projectId, userId: targetUserId },
    });

    if (result.count === 0) {
      throw new ProjectServiceError('PROJECT_SHARE_NOT_FOUND', 'The project share was not found.');
    }
  });
}
export async function updateProjectSpaFallback(
  userId: number,
  projectId: string,
  spaFallback: boolean,
) {
  await requireProjectPermission(userId, projectId, 'MANAGE');

  return prisma.$transaction(async (tx) => {
    const changed = await tx.project.updateMany({
      where: {
        id: projectId,
        archivedAt: null,
        spaFallback: { not: spaFallback },
      },
      data: { spaFallback },
    });

    const project = await tx.project.findFirst({
      where: { id: projectId, archivedAt: null },
      select: { id: true, spaFallback: true },
    });

    if (!project) {
      throw new ProjectAuthorizationError(
        'PROJECT_ACCESS_DENIED',
        'The project was not found or you do not have permission to perform this action.',
      );
    }

    if (changed.count === 0) {
      return { project, routingRefreshQueued: false };
    }

    const deployment = await tx.deployment.findFirst({
      where: { projectId, status: 'READY' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });

    if (!deployment) {
      return { project, routingRefreshQueued: false };
    }

    await tx.deploymentOutbox.create({
      data: {
        deploymentId: deployment.id,
        eventType: 'DEPLOYMENT_ROUTING_REQUESTED',
        payload: { deploymentId: deployment.id, projectId },
      },
    });

    return { project, routingRefreshQueued: true };
  });
}
const projectDirectorySchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => {
    if (
      value.startsWith('/') ||
      /^[a-zA-Z]:/.test(value) ||
      value.includes('\\') ||
      value.includes('\0')
    ) {
      return false;
    }

    const normalized = posix.normalize(value);

    return normalized !== '..' && !normalized.startsWith('../');
  }, 'Use a relative directory that stays inside the project.');

export const updateProjectSettingsSchema = z
  .object({
    rootDirectory: projectDirectorySchema.optional(),
    installCommand: z.string().trim().max(500).optional(),
    buildCommand: z.string().trim().max(500).optional(),
    outputDirectory: projectDirectorySchema.optional(),
    spaFallback: z.boolean().optional(),
  })
  .strict()
  .refine(
    (settings) => Object.values(settings).some((value) => value !== undefined),
    'Provide at least one project setting.',
  );
const accessibleGitHubRepositoriesSchema = z.object({
  repositories: z.array(
    z.object({
      id: z.number().int().positive().safe(),
    }),
  ),
});

export async function requireGitHubRepositoryAccess(
  userId: number,
  installationId: number,
  repositoryId: number,
): Promise<void> {
  const connection = await prisma.gitHubConnection.findUnique({
    where: { userId },
    select: {
      accessTokenEncrypted: true,
      accessTokenExpiresAt: true,
    },
  });

  if (!connection) {
    throw new ProjectServiceError(
      'GITHUB_CONNECTION_REQUIRED',
      'Connect your GitHub account first.',
    );
  }

  if (
    connection.accessTokenExpiresAt !== null &&
    connection.accessTokenExpiresAt.getTime() <= Date.now()
  ) {
    throw new ProjectServiceError(
      'GITHUB_REAUTHORIZATION_REQUIRED',
      'Your GitHub authorization expired. Connect GitHub again.',
    );
  }

  let accessToken: string;

  try {
    accessToken = await getGitHubUserAccessToken(userId);
  } catch (error: unknown) {
    if (error instanceof GitHubUserTokenError) {
      throw new ProjectServiceError(error.code, error.message);
    }

    throw error;
  }

  // One deadline covers the complete paginated lookup.
  const signal = AbortSignal.timeout(30_000);
  let page = 1;

  try {
    while (true) {
      const url = new URL(
        `https://api.github.com/user/installations/${installationId}/repositories`,
      );

      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));

      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'DeployMe',
        },
        redirect: 'error',
        signal,
      });

      if (response.status === 401) {
        throw new ProjectServiceError(
          'GITHUB_REAUTHORIZATION_REQUIRED',
          'GitHub authorization is no longer valid. Connect GitHub again.',
        );
      }

      if (response.status === 404) {
        throw new ProjectServiceError(
          'GITHUB_USER_REPOSITORY_ACCESS_DENIED',
          'The selected repository or installation is not accessible to your GitHub account.',
        );
      }

      if (!response.ok) {
        throw new ProjectServiceError(
          'GITHUB_ACCESS_CHECK_FAILED',
          'GitHub could not verify repository access. Please retry later.',
        );
      }

      const result = accessibleGitHubRepositoriesSchema.safeParse(await response.json());

      if (!result.success) {
        throw new ProjectServiceError(
          'GITHUB_ACCESS_CHECK_FAILED',
          'GitHub returned an invalid repository response.',
        );
      }

      if (result.data.repositories.some((repository) => repository.id === repositoryId)) {
        return;
      }

      if (!/rel="next"/.test(response.headers.get('link') ?? '')) {
        throw new ProjectServiceError(
          'GITHUB_USER_REPOSITORY_ACCESS_DENIED',
          'The selected repository is not accessible to your GitHub account through this installation.',
        );
      }

      page += 1;
    }
  } catch (error: unknown) {
    if (error instanceof ProjectServiceError) {
      throw error;
    }

    throw new ProjectServiceError(
      'GITHUB_ACCESS_CHECK_FAILED',
      'Unable to verify GitHub repository access. Please retry later.',
    );
  }
}

export async function connectGitHubRepository(input: {
  userId: number;
  projectId: string;
  installationId: number;
  repositoryId: number;
  owner: string;
  name: string;
  defaultBranch: string;
}) {
  await requireGitHubRepositoryAccess(input.userId, input.installationId, input.repositoryId);
  if (
    !Number.isSafeInteger(input.installationId) ||
    input.installationId <= 0 ||
    !Number.isSafeInteger(input.repositoryId) ||
    input.repositoryId <= 0
  ) {
    throw new ProjectServiceError(
      'INVALID_GITHUB_REPOSITORY',
      'Invalid GitHub installation or repository ID.',
    );
  }

  const owner = input.owner.trim();
  const name = input.name.trim();
  const defaultBranch = input.defaultBranch.trim();

  if (!owner || !name || !defaultBranch) {
    throw new ProjectServiceError(
      'INVALID_GITHUB_REPOSITORY',
      'Repository owner, name, and default branch are required.',
    );
  }
  await requireGitHubRepositoryAccess(input.userId, input.installationId, input.repositoryId);
  let installation;

  try {
    installation = await syncGitHubInstallation(input.installationId);
  } catch {
    throw new ProjectServiceError(
      'GITHUB_INSTALLATION_SYNC_FAILED',
      'Unable to sync the GitHub installation. Please retry later.',
    );
  }
  const repositories = await listInstallationRepositories(input.installationId);

  const repository = repositories.find(
    (item) =>
      item.id === input.repositoryId &&
      item.fullName.toLowerCase() === `${owner}/${name}`.toLowerCase() &&
      item.defaultBranch === defaultBranch,
  );

  if (!repository) {
    throw new ProjectServiceError(
      'GITHUB_REPOSITORY_NOT_ACCESSIBLE',
      'The repository details do not match a repository accessible to this GitHub App installation.',
    );
  }
  const [verifiedOwner, verifiedName] = repository.fullName.split('/');

  if (!verifiedOwner || !verifiedName) {
    throw new ProjectServiceError(
      'INVALID_GITHUB_REPOSITORY',
      'GitHub returned an invalid repository name.',
    );
  }

  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const project = await tx.project.findUnique({
            where: { id: input.projectId },
            select: {
              id: true,
              subdomain: true,
              archivedAt: true,
              gitRepository: {
                select: {
                  providerRepositoryId: true,
                  productionBranch: true,
                },
              },
            },
          });

          if (!project || project.archivedAt !== null) {
            throw new ProjectServiceError(
              'PROJECT_ACCESS_DENIED',
              'The project was not found or is archived.',
            );
          }

          if (project.subdomain === null) {
            const candidate = createRepositorySubdomainCandidate(verifiedName, attempt);

            try {
              await tx.project.update({
                where: { id: project.id },
                data: { subdomain: candidate },
              });
            } catch (error) {
              if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new ProjectServiceError(
                  'GENERATED_SUBDOMAIN_COLLISION',
                  'The generated subdomain is already in use.',
                );
              }

              throw error;
            }
          }
          const productionBranch =
            project.gitRepository?.providerRepositoryId === BigInt(repository.id)
              ? project.gitRepository.productionBranch
              : defaultBranch;
          try {
            return await tx.gitRepository.upsert({
              where: {
                projectId: input.projectId,
              },
              create: {
                productionBranch,
                projectId: input.projectId,
                installationRecordId: installation.id,
                providerRepositoryId: BigInt(repository.id),
                owner: verifiedOwner,
                name: verifiedName,
                defaultBranch,
              },
              update: {
                productionBranch,
                installationRecordId: installation.id,
                providerRepositoryId: BigInt(repository.id),
                owner: verifiedOwner,
                name: verifiedName,
                defaultBranch,
              },
            });
          } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
              throw new ProjectServiceError(
                'GITHUB_REPOSITORY_ALREADY_CONNECTED',
                'This GitHub repository is already connected to another project.',
              );
            }

            throw error;
          }
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (error) {
      const generatedNameCollision =
        error instanceof ProjectServiceError && error.code === 'GENERATED_SUBDOMAIN_COLLISION';

      const transactionConflict =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';

      if (generatedNameCollision || transactionConflict) {
        continue;
      }

      throw error;
    }
  }

  throw new ProjectServiceError(
    'PROJECT_CONNECTION_BUSY',
    'Could not complete the repository connection. Please retry.',
  );
}
export async function updateProjectSettings(
  userId: number,
  projectId: string,
  input: z.infer<typeof updateProjectSettingsSchema>,
) {
  await requireProjectPermission(userId, projectId, 'MANAGE');

  const parsed = updateProjectSettingsSchema.safeParse(input);

  if (!parsed.success) {
    throw new ProjectServiceError(
      'INVALID_PROJECT_INPUT',
      parsed.error.issues[0]?.message ?? 'Invalid project settings.',
    );
  }

  const settings = parsed.data;

  return prisma.$transaction(async (tx) => {
    const previous = await tx.project.findFirst({
      where: { id: projectId, archivedAt: null },
      select: { id: true, spaFallback: true },
    });

    if (!previous) {
      throw new ProjectAuthorizationError(
        'PROJECT_ACCESS_DENIED',
        'The project was not found or you cannot manage it.',
      );
    }

    const changed = await tx.project.updateMany({
      where: { id: projectId, archivedAt: null },
      data: {
        ...(settings.rootDirectory !== undefined && {
          rootDirectory: settings.rootDirectory,
        }),
        ...(settings.installCommand !== undefined && {
          installCommand: settings.installCommand,
        }),
        ...(settings.buildCommand !== undefined && {
          buildCommand: settings.buildCommand,
        }),
        ...(settings.outputDirectory !== undefined && {
          outputDirectory: settings.outputDirectory,
        }),
        ...(settings.spaFallback !== undefined && {
          spaFallback: settings.spaFallback,
        }),
      },
    });

    if (changed.count !== 1) {
      throw new ProjectAuthorizationError(
        'PROJECT_ACCESS_DENIED',
        'The project was not found or you cannot manage it.',
      );
    }

    const project = await tx.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        id: true,
        rootDirectory: true,
        installCommand: true,
        buildCommand: true,
        outputDirectory: true,
        spaFallback: true,
      },
    });

    const spaChanged =
      settings.spaFallback !== undefined && settings.spaFallback !== previous.spaFallback;

    if (!spaChanged) {
      return { project, routingRefreshQueued: false };
    }

    const deployment = await tx.deployment.findFirst({
      where: { projectId, status: 'READY' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });

    if (!deployment) {
      return { project, routingRefreshQueued: false };
    }

    await tx.deploymentOutbox.create({
      data: {
        deploymentId: deployment.id,
        eventType: 'DEPLOYMENT_ROUTING_REQUESTED',
        payload: { deploymentId: deployment.id, projectId },
      },
    });

    return { project, routingRefreshQueued: true };
  });
}
