import { createHash } from 'node:crypto';
import { z } from 'zod';
import { captureDeploymentBuildSettings } from './deployment-build-settings.js';
import { prisma } from '../config/database.js';
import { Prisma } from '../generated/prisma/client.js';
import { createProject } from './projects.js';
import { syncGitHubInstallation } from './github-app.js';
import { inspectGitHubProject } from './github-project-inspection.js';
import {
  assertDeploymentQuotaAvailable,
  lockDeploymentQuota,
  type DeploymentQuotaScope,
} from './deployment-quota.js';
import { lockTeamForMutation } from './team-lock.js';
import { publicBuildVariablesSchema } from './public-build-variables.js';
import { PNPM_INSTALL_COMMAND } from './build-runner.js';
import { lockActiveAccount } from './account-availability.js';

export class ProjectImportError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectImportError';
  }
}

function isSafeRelativePath(value: string): boolean {
  if (value === '.') return true;

  return (
    !/[\\:\0]/.test(value) &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

const relativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isSafeRelativePath, 'Provide a safe relative directory.');

export const projectImportSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    subdomain: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    teamId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    grantCreatorDeploy: z.boolean().optional(),
    installationId: z.number().int().positive().safe(),
    repositoryId: z.number().int().positive().safe(),
    owner: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
    repositoryName: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/)
      .refine((value) => value !== '.' && value !== '..'),
    publicBuildVariables: publicBuildVariablesSchema.optional(),
    // The commit returned by the inspection the user reviewed.
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),

    rootDirectory: relativePathSchema,
    installCommand: z.enum(['', 'npm ci', PNPM_INSTALL_COMMAND]),
    buildCommand: z.string().trim().max(500),
    outputDirectory: relativePathSchema,
    spaFallback: z.boolean(),
    settingsReviewed: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.teamId !== undefined && input.grantCreatorDeploy !== true) {
      context.addIssue({
        code: 'custom',
        path: ['grantCreatorDeploy'],
        message: 'Confirm your deployment permission for this team project.',
      });
    }

    if (input.teamId === undefined && input.grantCreatorDeploy !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['grantCreatorDeploy'],
        message: 'Deployment permission confirmation is only for team imports.',
      });
    }
  });

export const projectImportKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const importResultSelect = {
  requestHash: true,
  project: {
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
      archivedAt: true,
      createdAt: true,
      updatedAt: true,
      publicBuildVariables: true,
    },
  },
  deployment: {
    select: {
      id: true,
      projectId: true,
      commitSha: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      publishedAt: true,
    },
  },
} satisfies Prisma.ProjectImportRequestSelect;

type ImportRecord = Prisma.ProjectImportRequestGetPayload<{
  select: typeof importResultSelect;
}>;

async function requireTeamImporter(db: Prisma.TransactionClient, teamId: string, userId: number) {
  const membership = await db.teamMembership.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true },
  });

  if (!membership || !['OWNER', 'MANAGER'].includes(membership.role)) {
    throw new ProjectImportError(
      404,
      'The team was not found or you cannot import projects into it.',
    );
  }
}

async function formatResult(
  record: ImportRecord,
  userId: number,
  requestHash: string,
  replayed: boolean,
  teamId: string | undefined,
  db: Prisma.TransactionClient,
) {
  if (record.requestHash !== requestHash) {
    throw new ProjectImportError(
      409,
      'This idempotency key was already used with different import settings.',
    );
  }

  const project = record.project;

  const correctDestination =
    teamId === undefined
      ? project.ownerUserId === userId && project.teamId === null
      : project.ownerUserId === null && project.teamId === teamId;

  if (!correctDestination || project.archivedAt !== null) {
    throw new ProjectImportError(
      409,
      'The original imported project is no longer available for this request.',
    );
  }

  if (teamId !== undefined) {
    const membership = await db.teamMembership.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { role: true },
    });

    if (!membership) {
      throw new ProjectImportError(404, 'The team project is no longer accessible.');
    }

    if (membership.role === 'MEMBER') {
      const share = await db.projectShare.findUnique({
        where: {
          projectId_userId: {
            projectId: project.id,
            userId,
          },
        },
        select: { canView: true },
      });

      if (!share?.canView) {
        throw new ProjectImportError(404, 'The team project is no longer accessible.');
      }
    }
  }

  return {
    project,
    deployment: record.deployment,
    replayed,
  };
}

interface ProjectImportDependencies {
  inspect: (
    ...args: Parameters<typeof inspectGitHubProject>
  ) => Promise<
    Pick<
      Awaited<ReturnType<typeof inspectGitHubProject>>,
      'commitSha' | 'defaultBranch' | 'requiresReview' | 'settings'
    >
  >;
  syncInstallation: (installationId: number) => Promise<{ id: string }>;
}

const defaultImportDependencies: ProjectImportDependencies = {
  inspect: inspectGitHubProject,
  syncInstallation: syncGitHubInstallation,
};
export async function importProject(
  userId: number,
  rawKey: string,
  rawInput: unknown,
  dependencies: ProjectImportDependencies = defaultImportDependencies,
) {
  const keyResult = projectImportKeySchema.safeParse(rawKey);
  const inputResult = projectImportSchema.safeParse(rawInput);

  if (!keyResult.success || !inputResult.success) {
    throw new ProjectImportError(400, 'Provide a valid import request and idempotency key.');
  }

  const idempotencyKey = keyResult.data;
  const input = inputResult.data;

  // Sorting makes hashing independent of JSON property order.
  // Preserve existing hashes for requests without public build variables.
  // Variable insertion order must not change an otherwise identical request.
  const normalizedInput = {
    ...input,
    ...(input.publicBuildVariables !== undefined && {
      publicBuildVariables: Object.fromEntries(
        Object.entries(input.publicBuildVariables).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    }),
  };

  const normalizedEntries = Object.entries(normalizedInput).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  const requestHash = createHash('sha256').update(JSON.stringify(normalizedEntries)).digest('hex');

  const where = {
    userId_idempotencyKey: { userId, idempotencyKey },
  };

  async function findReplay() {
    return prisma.$transaction(async (tx) => {
      if (input.teamId !== undefined) {
        await lockTeamForMutation(tx, input.teamId);
      }

      const existing = await tx.projectImportRequest.findUnique({
        where,
        select: importResultSelect,
      });

      return existing ? formatResult(existing, userId, requestHash, true, input.teamId, tx) : null;
    });
  }

  const existing = await findReplay();

  if (existing) return existing;
  if (input.teamId !== undefined) {
    await requireTeamImporter(prisma, input.teamId, userId);
  }
  // This helper verifies the signed-in user's GitHub repository access.
  const inspection = await dependencies.inspect(userId, {
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    owner: input.owner,
    name: input.repositoryName,
    rootDirectory: input.rootDirectory,
  });

  if (inspection.commitSha !== input.commitSha) {
    // Another concurrent request might already have completed this import.
    const completed = await findReplay();

    if (completed) return completed;

    throw new ProjectImportError(
      409,
      'The repository changed since inspection. Inspect it again before importing.',
    );
  }
  const detected = inspection.settings;

  const matchesDetectedSettings =
    detected !== null &&
    input.installCommand === detected.installCommand &&
    input.buildCommand === detected.buildCommand &&
    input.outputDirectory === detected.outputDirectory &&
    input.spaFallback === detected.spaFallback;

  const needsReview = inspection.requiresReview || !matchesDetectedSettings;

  if (needsReview && !input.settingsReviewed) {
    const completed = await findReplay();

    if (completed) return completed;

    throw new ProjectImportError(
      422,
      'Review and confirm the deployment settings before importing this project.',
    );
  }
  // Synchronize shared installation metadata outside the project transaction.
  const installation = await dependencies.syncInstallation(input.installationId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          if (input.teamId !== undefined) {
            await lockTeamForMutation(tx, input.teamId);
          }

          const quotaScope: DeploymentQuotaScope =
            input.teamId === undefined
              ? { kind: 'personal', userId }
              : { kind: 'team', teamId: input.teamId };
          // Lock before replay lookup and before creating any project.
          await lockDeploymentQuota(tx, quotaScope);

          const previous = await tx.projectImportRequest.findUnique({
            where,
            select: importResultSelect,
          });

          // A replay creates no deployment, so it requires no free slot.
          if (previous) {
            return formatResult(previous, userId, requestHash, true, input.teamId, tx);
          }
          if (input.teamId !== undefined) {
            await requireTeamImporter(tx, input.teamId, userId);
          }

          await assertDeploymentQuotaAvailable(tx, quotaScope);
          if (quotaScope.kind === 'team') {
            await lockActiveAccount(tx, userId);
          }

          const project = await createProject(
            userId,
            {
              ...(input.teamId !== undefined && { teamId: input.teamId }),
              name: input.name,
              slug: input.slug,
              subdomain: input.subdomain,
              rootDirectory: input.rootDirectory,
              installCommand: input.installCommand,
              buildCommand: input.buildCommand,
              outputDirectory: input.outputDirectory,
              spaFallback: input.spaFallback,
            },
            tx,
          );
          if (input.publicBuildVariables !== undefined) {
            await tx.project.update({
              where: { id: project.id },
              data: {
                publicBuildVariables: input.publicBuildVariables,
              },
            });
          }
          await tx.gitRepository.create({
            data: {
              projectId: project.id,
              installationRecordId: installation.id,
              providerRepositoryId: BigInt(input.repositoryId),
              owner: input.owner,
              name: input.repositoryName,
              defaultBranch: inspection.defaultBranch,
              productionBranch: inspection.defaultBranch,
            },
          });
          if (input.teamId !== undefined) {
            await tx.projectShare.create({
              data: {
                projectId: project.id,
                userId,
                grantedByUserId: userId,
                canView: true,
                canDeploy: true,
                canManage: false,
              },
            });
          }
          // This request creates a new personal project owned by this user.
          // Existing-project deployment permissions remain in requestDeployment.
          const deployment = await tx.deployment.create({
            data: {
              projectId: project.id,
              commitSha: inspection.commitSha,
              status: 'PENDING',
              buildSettings: await captureDeploymentBuildSettings(tx, project.id),
            },
            select: {
              id: true,
              projectId: true,
            },
          });

          await tx.deploymentOutbox.create({
            data: {
              deploymentId: deployment.id,
              eventType: 'DEPLOYMENT_REQUESTED',
              payload: {
                deploymentId: deployment.id,
                projectId: project.id,
                commitSha: inspection.commitSha,
              },
            },
          });

          const record = await tx.projectImportRequest.create({
            data: {
              userId,
              idempotencyKey,
              requestHash,
              projectId: project.id,
              deploymentId: deployment.id,
            },
            select: importResultSelect,
          });

          return formatResult(record, userId, requestHash, false, input.teamId, tx);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')
      ) {
        // Concurrent identical requests should return the winner's result.
        const completed = await findReplay();

        if (completed) return completed;

        if (error.code === 'P2034') {
          if (attempt < 2) continue;

          throw new ProjectImportError(
            409,
            'The import is busy. Retry with the same idempotency key.',
          );
        }

        throw new ProjectImportError(
          409,
          'The project slug, subdomain, or repository is already in use.',
        );
      }

      throw error;
    }
  }

  throw new ProjectImportError(
    409,
    'The import could not complete. Retry with the same idempotency key.',
  );
}
export async function importPersonalProject(
  userId: number,
  rawKey: string,
  rawInput: unknown,
  dependencies: ProjectImportDependencies = defaultImportDependencies,
) {
  if (
    rawInput &&
    typeof rawInput === 'object' &&
    'teamId' in rawInput &&
    rawInput.teamId !== undefined
  ) {
    throw new ProjectImportError(400, 'This entry point only imports personal projects.');
  }

  return importProject(userId, rawKey, rawInput, dependencies);
}
