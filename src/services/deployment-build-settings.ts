import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';

import { publicBuildVariablesSchema } from './public-build-variables.js';

const commonBuildSettings = {
  rootDirectory: z.string().min(1).max(255),
  installCommand: z.string().max(500),
  buildCommand: z.string().max(500),
  outputDirectory: z.string().min(1).max(255),
};

const versionOneSchema = z
  .object({
    version: z.literal(1),
    ...commonBuildSettings,
  })
  .strict();

const versionTwoSchema = z
  .object({
    version: z.literal(2),
    ...commonBuildSettings,
    publicBuildVariables: publicBuildVariablesSchema,
  })
  .strict();

const buildSettingsSchema = z.discriminatedUnion('version', [versionOneSchema, versionTwoSchema]);

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

  if (result.data.version === 1) {
    // Older queued deployments use an empty variable snapshot.
    // Never substitute the project's current variables here.
    return {
      ...result.data,
      publicBuildVariables: publicBuildVariablesSchema.parse({}),
    };
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
      publicBuildVariables: true,
    },
  });

  if (!project) {
    throw new DeploymentBuildSettingsError(
      'Cannot capture build settings: project not found or archived.',
    );
  }

  // New deployments always persist version 2.
  const result = versionTwoSchema.safeParse({
    version: 2,
    ...project,
  });

  if (!result.success) {
    throw new DeploymentBuildSettingsError(
      'Cannot capture build settings: project settings are invalid.',
    );
  }

  return result.data;
}
