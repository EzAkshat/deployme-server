import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';

const buildSettingsSchema = z
  .object({
    version: z.literal(1),
    rootDirectory: z.string().min(1).max(255),
    installCommand: z.string().max(500),
    buildCommand: z.string().max(500),
    outputDirectory: z.string().min(1).max(255),
  })
  .strict();

export class DeploymentBuildSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentBuildSettingsError';
  }
}

export function readDeploymentBuildSettings(value: unknown) {
  if (value === null || value === undefined) {
    throw new DeploymentBuildSettingsError(
      'This deployment has no saved build settings. Request a new deployment.',
    );
  }

  const result = buildSettingsSchema.safeParse(value);

  if (!result.success) {
    throw new DeploymentBuildSettingsError(
      'This deployment has invalid saved build settings. Request a new deployment.',
    );
  }

  return result.data;
}

export async function captureDeploymentBuildSettings(
  tx: Prisma.TransactionClient,
  projectId: string,
) {
  const project = await tx.project.findFirst({
    where: {
      id: projectId,
      archivedAt: null,
    },
    select: {
      rootDirectory: true,
      installCommand: true,
      buildCommand: true,
      outputDirectory: true,
    },
  });

  if (!project) {
    throw new DeploymentBuildSettingsError(
      'Cannot capture build settings: project not found or archived.',
    );
  }

  return readDeploymentBuildSettings({
    version: 1,
    ...project,
  });
}
