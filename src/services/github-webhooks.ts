import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { prisma } from '../config/database.js';
import { captureDeploymentBuildSettings } from './deployment-build-settings.js';
import { enforceProjectDeploymentQuota } from './deployment-quota.js';

export class GitHubWebhookError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubWebhookError';
  }
}

export function verifyGitHubWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
): boolean {
  const secret = env.GITHUB_WEBHOOK_SECRET;

  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(signature.slice('sha256='.length), 'hex');

  return received.length === expected.length && timingSafeEqual(received, expected);
}

type GitHubPushPayload = {
  ref?: unknown;
  after?: unknown;
  deleted?: unknown;
  repository?: { id?: unknown };
  installation?: { id?: unknown };
};

export async function processGitHubWebhookDelivery(input: {
  deliveryId: string;
  event: string;
  payload: unknown;
}) {
  const deliveryId = input.deliveryId.trim();
  const event = input.event.trim();

  if (!deliveryId || !event) {
    throw new GitHubWebhookError('INVALID_DELIVERY', 'GitHub delivery ID and event are required.');
  }

  // Record receipt separately so a rolled-back transaction can be retried.
  try {
    await prisma.gitHubWebhookDelivery.create({
      data: { deliveryId, event, status: 'RECEIVED' },
    });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'P2002') {
      throw error;
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.gitHubWebhookDelivery.updateMany({
        where: {
          deliveryId,
          status: { in: ['RECEIVED', 'FAILED'] },
        },
        data: { status: 'PROCESSING', error: null },
      });

      if (claimed.count === 0) {
        const existing = await tx.gitHubWebhookDelivery.findUniqueOrThrow({
          where: { deliveryId },
          select: { status: true },
        });

        return { duplicate: true, status: existing.status };
      }

      async function ignoreDelivery() {
        await tx.gitHubWebhookDelivery.update({
          where: { deliveryId },
          data: { status: 'IGNORED', processedAt: new Date(), error: null },
        });

        return { duplicate: false, status: 'IGNORED' };
      }

      if (event !== 'push') {
        return ignoreDelivery();
      }

      if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
        throw new GitHubWebhookError('INVALID_PAYLOAD', 'Invalid GitHub push payload.');
      }

      const payload = input.payload as GitHubPushPayload;
      const repositoryId = payload.repository?.id;
      const ref = payload.ref;
      const commitSha = payload.after;

      if (
        typeof repositoryId !== 'number' ||
        !Number.isSafeInteger(repositoryId) ||
        repositoryId <= 0 ||
        typeof ref !== 'string' ||
        typeof commitSha !== 'string' ||
        !/^[a-f0-9]{40}$/i.test(commitSha)
      ) {
        throw new GitHubWebhookError(
          'INVALID_PAYLOAD',
          'GitHub push payload must include a valid repository ID, ref, and commit SHA.',
        );
      }

      if (payload.deleted === true) {
        return ignoreDelivery();
      }

      const installationId = payload.installation?.id;

      if (
        typeof installationId !== 'number' ||
        !Number.isSafeInteger(installationId) ||
        installationId <= 0
      ) {
        throw new GitHubWebhookError(
          'INVALID_PAYLOAD',
          'GitHub push payload must include a valid installation ID.',
        );
      }

      const repository = await tx.gitRepository.findFirst({
        where: {
          providerRepositoryId: BigInt(repositoryId),
          installation: { installationId: BigInt(installationId) },
        },
        select: {
          productionBranch: true,
          project: { select: { id: true, archivedAt: true } },
        },
      });

      if (
        !repository ||
        repository.project.archivedAt !== null ||
        ref !== `refs/heads/${repository.productionBranch}`
      ) {
        return ignoreDelivery();
      }

      const projectId = repository.project.id;

      await enforceProjectDeploymentQuota(tx, projectId);

      const deployment = await tx.deployment.create({
        data: {
          projectId,
          commitSha,
          status: 'PENDING',
          buildSettings: await captureDeploymentBuildSettings(tx, projectId),
        },
        select: { id: true },
      });

      await tx.deploymentOutbox.create({
        data: {
          deploymentId: deployment.id,
          eventType: 'DEPLOYMENT_REQUESTED',
          payload: {
            deploymentId: deployment.id,
            projectId,
            source: 'github-push',
            repositoryId,
            ref,
            commitSha,
          },
        },
      });

      await tx.gitHubWebhookDelivery.update({
        where: { deliveryId },
        data: { status: 'PROCESSED', processedAt: new Date(), error: null },
      });

      return {
        duplicate: false,
        status: 'PROCESSED',
        deploymentId: deployment.id,
      };
    });
  } catch (error) {
    // A concurrent redelivery may already have completed after rollback.
    await prisma.gitHubWebhookDelivery
      .updateMany({
        where: {
          deliveryId,
          status: { in: ['RECEIVED', 'FAILED'] },
        },
        data: {
          status: 'FAILED',
          error:
            error instanceof Error
              ? error.message.slice(0, 2000)
              : 'Unknown webhook processing error',
        },
      })
      .catch(() => undefined);

    throw error;
  }
}
