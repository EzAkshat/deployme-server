import { createHash } from 'node:crypto';
import { z } from 'zod';
import { captureDeploymentBuildSettings } from './deployment-build-settings.js';
import { prisma } from '../config/database.js';
import { Prisma } from '../generated/prisma/client.js';
import { createProject } from './projects.js';
import { syncGitHubInstallation } from './github-app.js';
import { inspectGitHubProject } from './github-project-inspection.js';
import { assertDeploymentQuotaAvailable, lockDeploymentQuota } from './deployment-quota.js';

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

    // The commit returned by the inspection the user reviewed.
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),

    rootDirectory: relativePathSchema,
    installCommand: z.enum(['', 'npm ci']),
    buildCommand: z.string().trim().max(500),
    outputDirectory: relativePathSchema,
    spaFallback: z.boolean(),
    settingsReviewed: z.boolean().default(false),
  })
  .strict();

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

function formatResult(
  record: ImportRecord,
  userId: number,
  requestHash: string,
  replayed: boolean,
) {
  if (record.requestHash !== requestHash) {
    throw new ProjectImportError(
      409,
      'This idempotency key was already used with different import settings.',
    );
  }

  if (
    record.project.ownerUserId !== userId ||
    record.project.teamId !== null ||
    record.project.archivedAt !== null
  ) {
    throw new ProjectImportError(
      409,
      'The original imported project is no longer available for this request.',
    );
  }

  return {
    project: record.project,
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
export async function importPersonalProject(
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
  const normalizedEntries = Object.entries(input).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  const requestHash = createHash('sha256').update(JSON.stringify(normalizedEntries)).digest('hex');

  const where = {
    userId_idempotencyKey: { userId, idempotencyKey },
  };

  async function findReplay() {
    const existing = await prisma.projectImportRequest.findUnique({
      where,
      select: importResultSelect,
    });

    return existing ? formatResult(existing, userId, requestHash, true) : null;
  }

  const existing = await findReplay();

  if (existing) return existing;

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
          const quotaScope = {
            kind: 'personal' as const,
            userId,
          };

          // Lock before replay lookup and before creating any project.
          await lockDeploymentQuota(tx, quotaScope);

          const previous = await tx.projectImportRequest.findUnique({
            where,
            select: importResultSelect,
          });

          // A replay creates no deployment, so it requires no free slot.
          if (previous) {
            return formatResult(previous, userId, requestHash, true);
          }

          await assertDeploymentQuotaAvailable(tx, quotaScope);

          const project = await createProject(
            userId,
            {
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

          return formatResult(record, userId, requestHash, false);
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
