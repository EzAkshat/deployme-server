import type { Job } from 'bullmq';

import { prisma } from '../config/database.js';
import {
  DeploymentAccountSuspendedError,
  lockDeploymentOwner,
} from './deployment-account-guard.js';

export const DEPLOYMENT_LOCK_DURATION_MS = 60_000;

interface DeploymentClaimJobData {
  deploymentId: string;
  projectId: string;
  commitSha: string;
  outboxEventId: string;
}

export async function claimDeploymentExecution(
  job: Job<DeploymentClaimJobData>,
  queueToken: string,
  processingToken: string,
): Promise<boolean> {
  const { deploymentId, projectId, commitSha, outboxEventId } = job.data;
  const jobId = job.id;
  const attempt = job.attemptsStarted;

  if (
    !jobId ||
    jobId !== `outbox-${outboxEventId}` ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  ) {
    throw new Error('Invalid deployment job identity or execution number');
  }

  const event = await prisma.deploymentOutbox.findFirst({
    where: {
      id: outboxEventId,
      deploymentId,
      eventType: 'DEPLOYMENT_REQUESTED',
    },
    select: { payload: true },
  });

  const payload = event?.payload;

  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    payload.deploymentId !== deploymentId ||
    payload.projectId !== projectId ||
    payload.commitSha !== commitSha
  ) {
    throw new Error('Deployment job does not match its outbox event');
  }

  if ((await job.extendLock(queueToken, DEPLOYMENT_LOCK_DURATION_MS)) !== 1) {
    throw new Error('Deployment queue ownership was lost before claiming');
  }

  return prisma.$transaction(async (tx) => {
    // Lock the personal owner before touching the deployment.
    const ownerActive = await lockDeploymentOwner(tx, projectId);
    const now = new Date();

    const claimed = await tx.deployment.updateMany({
      where: {
        id: deploymentId,
        projectId,
        commitSha,
        OR: [
          {
            processingJobId: null,
            processingToken: null,
            status: { in: ['PENDING', 'QUEUED'] },
          },
          {
            processingJobId: jobId,
            processingAttempt: { lt: attempt },
            status: { in: ['PENDING', 'QUEUED', 'BUILDING'] },
          },
        ],
      },
      data: {
        status: 'BUILDING',
        processingJobId: jobId,
        processingAttempt: attempt,
        processingToken,
        processingStartedAt: now,
        buildFinishedAt: null,
      },
    });

    // Stale executions must not modify a newer claim.
    if (claimed.count !== 1) {
      return false;
    }

    if ((await job.extendLock(queueToken, DEPLOYMENT_LOCK_DURATION_MS)) !== 1) {
      throw new Error('Deployment queue ownership was lost during claiming');
    }

    // Commit the terminal state and return false so the worker skips building.
    if (!ownerActive) {
      const stopped = await tx.deployment.updateMany({
        where: {
          id: deploymentId,
          projectId,
          status: 'BUILDING',
          processingToken,
          processingJobId: jobId,
          processingAttempt: attempt,
        },
        data: {
          status: 'FAILED',
          failureReason: new DeploymentAccountSuspendedError().message,
          buildFinishedAt: now,
          processingToken: null,
          processingStartedAt: null,
        },
      });

      if (stopped.count !== 1) {
        throw new Error('Deployment ownership changed while stopping the build.');
      }

      return false;
    }

    // Only an allowed build receives its first build-start timestamp.
    await tx.deployment.updateMany({
      where: {
        id: deploymentId,
        projectId,
        processingToken,
        buildStartedAt: null,
      },
      data: { buildStartedAt: now },
    });

    return true;
  });
}
