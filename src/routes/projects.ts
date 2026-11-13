import { Router, type Response } from 'express';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requireTrustedOrigin } from '../middleware/require-origin.js';
import {
  createProject,
  getProject,
  listTeamProjects,
  listPersonalProjects,
  setProjectShare,
  revokeProjectShare,
  connectGitHubRepository,
  ProjectServiceError,
  updateProjectSettings,
  updateProjectSettingsSchema,
  getProjectOverview,
} from '../services/projects.js';
import { ProjectAuthorizationError } from '../services/project-authorization.js';
import {
  requestDeployment,
  DeploymentServiceError,
  listProjectDeployments,
  getProjectDeployment,
} from '../services/deployments.js';
import {
  importPersonalProject,
  projectImportSchema,
  projectImportKeySchema,
  ProjectImportError,
} from '../services/project-import.js';
import { GitHubInspectionError } from '../services/github-project-inspection.js';
import { GitHubUserTokenError } from '../services/github-user-token.js';
import { getDeploymentLogs } from '../services/deployment-logs.js';
import { archiveProject } from '../services/project-archive.js';
import {
  listArchivedPersonalProjects,
  listArchivedTeamProjects,
} from '../services/archived-projects.js';
import { DeploymentQuotaError } from '../services/deployment-quota.js';

const setProjectShareSchema = z.object({
  userId: z.number().int().positive(),
  canView: z.boolean(),
  canDeploy: z.boolean(),
  canManage: z.boolean(),
});

const createProjectSchema = z.object({
  teamId: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'Slug must contain lowercase letters, numbers, and single hyphens.',
    ),
  rootDirectory: z.string().trim().min(1).max(255).optional(),
  installCommand: z.string().trim().max(500).optional(),
  buildCommand: z.string().trim().max(500).optional(),
  outputDirectory: z.string().trim().min(1).max(255).optional(),
  spaFallback: z.boolean().optional(),
  subdomain: z.string().trim().min(1).max(63).optional(),
});
const deploymentPaginationSchema = z.object({
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/, 'Limit must be an integer from 1 to 100.')
    .transform(Number)
    .refine((value) => value <= 100, 'Limit must not exceed 100.')
    .optional(),
  cursor: z.string().trim().min(1).max(128).optional(),
});
const connectGitHubRepositorySchema = z.object({
  installationId: z.number().int().positive().safe(),
  repositoryId: z.number().int().positive().safe(),
  owner: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(255),
  defaultBranch: z.string().trim().min(1).max(255),
});
function getRouteParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function handleProjectError(res: Response, error: unknown, operation: string): void {
  if (error instanceof DeploymentQuotaError) {
    res.setHeader('Retry-After', '30');
    res.status(429).json({
      error: {
        code: error.code,
        message: error.message,
        limit: error.limit,
        activeCount: error.activeCount,
      },
    });
    return;
  }
  if (error instanceof ProjectServiceError || error instanceof ProjectAuthorizationError) {
    const statusByCode: Record<string, number> = {
      GITHUB_INSTALLATION_NOT_FOUND: 404,
      GITHUB_REPOSITORY_NOT_ACCESSIBLE: 400,
      GITHUB_REPOSITORY_ALREADY_CONNECTED: 409,
      PROJECT_SHARE_NOT_FOUND: 404,
      PROJECT_MANAGE_DENIED: 404,
      TARGET_NOT_TEAM_MEMBER: 403,
      TEAM_ACCESS_DENIED: 404,
      PROJECT_ACCESS_DENIED: 404,
      PROJECT_CREATE_DENIED: 404,
      INVALID_PROJECT_INPUT: 400,
      PROJECT_CONNECTION_BUSY: 409,
      GITHUB_CONNECTION_REQUIRED: 409,
      GITHUB_REAUTHORIZATION_REQUIRED: 409,
      GITHUB_USER_REPOSITORY_ACCESS_DENIED: 403,
      GITHUB_ACCESS_CHECK_FAILED: 502,
      GITHUB_INSTALLATION_SYNC_FAILED: 502,
      GITHUB_AUTHORIZATION_NOT_CONFIGURED: 503,
      GITHUB_TOKEN_REFRESH_FAILED: 502,
    };

    res.status(statusByCode[error.code] ?? 400).json({
      error: { message: error.message },
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    res.status(409).json({
      error: {
        message: 'The project slug or subdomain is already in use.',
      },
    });
    return;
  }

  logger.error({ err: error }, operation);

  res.status(500).json({
    error: {
      message: 'Unable to complete the request right now.',
    },
  });
}

export function createProjectsRouter() {
  const projectsRouter = Router();
  projectsRouter.post('/import', requireTrustedOrigin, requireAuth, async (req, res) => {
    const keyResult = projectImportKeySchema.safeParse(req.get('Idempotency-Key'));
    const inputResult = projectImportSchema.safeParse(req.body);

    if (!keyResult.success) {
      res.status(400).json({
        error: {
          message:
            'Provide an Idempotency-Key header containing 16–128 letters, numbers, underscores, or hyphens.',
        },
      });
      return;
    }

    if (!inputResult.success) {
      res.status(400).json({
        error: {
          message: 'Please provide valid project import settings.',
          details: inputResult.error.flatten().fieldErrors,
        },
      });
      return;
    }

    try {
      const result = await importPersonalProject(
        res.locals.authenticatedUser.id,
        keyResult.data,
        inputResult.data,
      );

      res.status(result.replayed ? 200 : 202).json({
        message: result.replayed
          ? 'Returning the original project import.'
          : 'Project imported and deployment requested.',
        ...result,
      });
    } catch (error: unknown) {
      if (
        error instanceof ProjectImportError ||
        error instanceof GitHubInspectionError ||
        error instanceof GitHubUserTokenError
      ) {
        res.status(error.status).json({
          error: { message: error.message },
        });
        return;
      }

      handleProjectError(res, error, 'Project import failed');
    }
  });
  projectsRouter.get('/:projectId/deployments', requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    const projectId = getRouteParam(req.params.projectId);
    const query = deploymentPaginationSchema.safeParse(req.query);

    if (!projectId || !query.success) {
      res.status(400).json({
        error: {
          message: !query.success
            ? (query.error.issues[0]?.message ?? 'Invalid pagination.')
            : 'A valid project ID is required.',
        },
      });
      return;
    }

    try {
      const result = await listProjectDeployments(res.locals.authenticatedUser.id, projectId, {
        ...(query.data.limit !== undefined && {
          limit: query.data.limit,
        }),
        ...(query.data.cursor !== undefined && {
          cursor: query.data.cursor,
        }),
      });

      res.status(200).json(result);
    } catch (error: unknown) {
      if (error instanceof DeploymentServiceError && error.code === 'INVALID_PAGINATION') {
        res.status(400).json({
          error: { message: error.message },
        });
        return;
      }

      handleProjectError(res, error, 'Deployment history lookup failed');
    }
  });

  projectsRouter.get('/:projectId/deployments/:deploymentId', requireAuth, async (req, res) => {
    const projectId = getRouteParam(req.params.projectId);
    const deploymentId = getRouteParam(req.params.deploymentId);

    if (!projectId || !deploymentId) {
      res.status(400).json({
        error: { message: 'A valid project ID and deployment ID are required.' },
      });
      return;
    }

    try {
      const deployment = await getProjectDeployment(
        res.locals.authenticatedUser.id,
        projectId,
        deploymentId,
      );

      if (!deployment) {
        res.status(404).json({ error: { message: 'Deployment not found.' } });
        return;
      }

      res.status(200).json({ deployment });
    } catch (error: unknown) {
      handleProjectError(res, error, 'Deployment lookup failed');
    }
  });
  projectsRouter.get('/personal', requireAuth, async (_req, res) => {
    try {
      const projects = await listPersonalProjects(res.locals.authenticatedUser.id);
      res.status(200).json({ projects });
    } catch (error: unknown) {
      handleProjectError(res, error, 'Personal project listing failed');
    }
  });
  // Create a project in a team.
  projectsRouter.post('/', requireTrustedOrigin, requireAuth, async (req, res) => {
    const result = createProjectSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        error: {
          message: 'Please provide a valid team ID, project name, and slug.',
          details: result.error.flatten().fieldErrors,
        },
      });
      return;
    }

    try {
      const project = await createProject(res.locals.authenticatedUser.id, result.data);

      res.status(201).json({
        message: 'Project created successfully.',
        project,
      });
    } catch (error: unknown) {
      handleProjectError(res, error, 'Project creation failed');
    }
  });
  projectsRouter.patch(
    '/:projectId/settings',
    requireTrustedOrigin,
    requireAuth,
    async (req, res) => {
      const projectId = getRouteParam(req.params.projectId);
      const result = updateProjectSettingsSchema.safeParse(req.body);

      if (!projectId || !result.success) {
        res.status(400).json({
          error: {
            message: !result.success
              ? (result.error.issues[0]?.message ?? 'Invalid project settings.')
              : 'Provide a valid project ID.',
          },
        });
        return;
      }

      try {
        const settings = await updateProjectSettings(
          res.locals.authenticatedUser.id,
          projectId,
          result.data,
        );

        res.status(200).json(settings);
      } catch (error: unknown) {
        handleProjectError(res, error, 'Project settings update failed');
      }
    },
  );
  // List projects visible to the authenticated user in a team.
  projectsRouter.get('/teams/:teamId/projects', requireAuth, async (req, res) => {
    const teamId = getRouteParam(req.params.teamId);

    if (!teamId) {
      res.status(400).json({
        error: { message: 'A valid team ID is required.' },
      });
      return;
    }

    try {
      const projects = await listTeamProjects(res.locals.authenticatedUser.id, teamId);

      res.status(200).json({ projects });
    } catch (error: unknown) {
      handleProjectError(res, error, 'Project listing failed');
    }
  });

  projectsRouter.post(
    '/:projectId/deployments',
    requireTrustedOrigin,
    requireAuth,
    async (req, res) => {
      const projectId = getRouteParam(req.params.projectId);

      if (!projectId) {
        res.status(400).json({
          error: { message: 'A valid project ID is required.' },
        });
        return;
      }

      try {
        const deployment = await requestDeployment(res.locals.authenticatedUser.id, projectId);

        res.status(202).json({
          message: 'Deployment request accepted.',
          deployment,
        });
      } catch (error: unknown) {
        if (error instanceof ProjectAuthorizationError && error.code === 'PROJECT_DEPLOY_DENIED') {
          res.status(404).json({
            error: {
              message: 'The project was not found or you do not have permission to deploy it.',
            },
          });
          return;
        }

        if (error instanceof DeploymentServiceError && error.code === 'PROJECT_NOT_FOUND') {
          res.status(404).json({
            error: { message: error.message },
          });
          return;
        }

        handleProjectError(res, error, 'Deployment request failed');
      }
    },
  );
  // Connect a GitHub repository to a project.
  projectsRouter.post(
    '/:projectId/github-repository',
    requireTrustedOrigin,
    requireAuth,
    async (req, res) => {
      const projectId = getRouteParam(req.params.projectId);

      if (!projectId) {
        res.status(400).json({
          error: { message: 'A valid project ID is required.' },
        });
        return;
      }

      const result = connectGitHubRepositorySchema.safeParse(req.body);

      if (!result.success) {
        res.status(400).json({
          error: {
            message: 'Please provide valid GitHub installation and repository details.',
            details: result.error.flatten().fieldErrors,
          },
        });
        return;
      }

      try {
        const repository = await connectGitHubRepository({
          userId: res.locals.authenticatedUser.id,
          projectId,
          ...result.data,
        });

        res.status(200).json({
          message: 'GitHub repository connected successfully.',
          repository: {
            ...repository,
            providerRepositoryId: repository.providerRepositoryId.toString(),
          },
        });
      } catch (error: unknown) {
        handleProjectError(res, error, 'GitHub repository connection failed');
      }
    },
  );
  // Grant or update a user's permissions for a project.
  projectsRouter.put('/:projectId/shares', requireTrustedOrigin, requireAuth, async (req, res) => {
    const projectId = getRouteParam(req.params.projectId);

    if (!projectId) {
      res.status(400).json({
        error: { message: 'A valid project ID is required.' },
      });
      return;
    }

    const result = setProjectShareSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        error: {
          message: 'Please provide a valid user ID and permission settings.',
          details: result.error.flatten().fieldErrors,
        },
      });
      return;
    }

    try {
      const share = await setProjectShare(res.locals.authenticatedUser.id, {
        projectId,
        targetUserId: result.data.userId,
        canView: result.data.canView,
        canDeploy: result.data.canDeploy,
        canManage: result.data.canManage,
      });

      res.status(200).json({
        message: 'Project permissions updated successfully.',
        share,
      });
    } catch (error: unknown) {
      handleProjectError(res, error, 'Project sharing failed');
    }
  });

  projectsRouter.delete(
    '/:projectId/shares/:userId',
    requireTrustedOrigin,
    requireAuth,
    async (req, res) => {
      const projectId = getRouteParam(req.params.projectId);
      const targetUserIdParam = getRouteParam(req.params.userId);
      const targetUserId = Number(targetUserIdParam);

      if (
        !projectId ||
        !targetUserIdParam ||
        !Number.isSafeInteger(targetUserId) ||
        targetUserId <= 0
      ) {
        res.status(400).json({
          error: { message: 'Valid project and user IDs are required.' },
        });
        return;
      }

      try {
        await revokeProjectShare(res.locals.authenticatedUser.id, projectId, targetUserId);

        res.status(200).json({
          message: 'Project access revoked successfully.',
        });
      } catch (error: unknown) {
        handleProjectError(res, error, 'Project share revocation failed');
      }
    },
  );
  projectsRouter.get('/personal/archived', requireAuth, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    try {
      const projects = await listArchivedPersonalProjects(res.locals.authenticatedUser.id);

      res.status(200).json({ projects });
    } catch (error: unknown) {
      handleProjectError(res, error, 'Archived personal project listing failed');
    }
  });

  projectsRouter.get('/teams/:teamId/projects/archived', requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    const teamId = getRouteParam(req.params.teamId);

    if (!teamId) {
      res.status(400).json({
        error: { message: 'A valid team ID is required.' },
      });
      return;
    }

    try {
      const projects = await listArchivedTeamProjects(res.locals.authenticatedUser.id, teamId);

      res.status(200).json({ projects });
    } catch (error: unknown) {
      handleProjectError(res, error, 'Archived team project listing failed');
    }
  });
  // Retrieve a project only when the user has viewing permission.
  projectsRouter.get('/:projectId', requireAuth, async (req, res) => {
    const projectId = getRouteParam(req.params.projectId);

    if (!projectId) {
      res.status(400).json({
        error: { message: 'A valid project ID is required.' },
      });
      return;
    }

    try {
      const project = await getProject(res.locals.authenticatedUser.id, projectId);

      res.status(200).json({ project });
    } catch (error: unknown) {
      handleProjectError(res, error, 'Project retrieval failed');
    }
  });
  projectsRouter.get(
    '/:projectId/deployments/:deploymentId/logs',
    requireAuth,
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');

      const projectId = getRouteParam(req.params.projectId);
      const deploymentId = getRouteParam(req.params.deploymentId);

      if (!projectId || !deploymentId) {
        res.status(400).json({
          error: {
            message: 'A valid project ID and deployment ID are required.',
          },
        });
        return;
      }

      try {
        const deployment = await getDeploymentLogs(
          res.locals.authenticatedUser.id,
          projectId,
          deploymentId,
        );

        if (!deployment) {
          res.status(404).json({
            error: { message: 'Deployment not found.' },
          });
          return;
        }

        res.status(200).json({ deployment });
      } catch (error: unknown) {
        handleProjectError(res, error, 'Deployment log lookup failed');
      }
    },
  );
  projectsRouter.post(
    '/:projectId/archive',
    requireTrustedOrigin,
    requireAuth,
    async (req, res) => {
      const projectId = getRouteParam(req.params.projectId);

      if (!projectId) {
        res.status(400).json({
          error: { message: 'A valid project ID is required.' },
        });
        return;
      }

      try {
        const result = await archiveProject(res.locals.authenticatedUser.id, projectId);

        const pending = result.deliveryDisableStatus === 'pending';

        res.status(pending ? 202 : 200).json({
          message: pending
            ? 'Project archived. Public delivery shutdown is pending.'
            : 'Project archived and public delivery disabled.',
          ...result,
        });
      } catch (error: unknown) {
        handleProjectError(res, error, 'Project archival failed');
      }
    },
  );
  projectsRouter.get('/:projectId/overview', requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    const projectId = getRouteParam(req.params.projectId);

    if (!projectId) {
      res.status(400).json({
        error: { message: 'A valid project ID is required.' },
      });
      return;
    }

    try {
      const overview = await getProjectOverview(res.locals.authenticatedUser.id, projectId);

      res.status(200).json({ overview });
    } catch (error: unknown) {
      handleProjectError(res, error, 'Project overview lookup failed');
    }
  });

  return projectsRouter;
}

export const projectsRouter = createProjectsRouter();
