import type { Job } from 'bullmq';

import { prisma } from '../config/database.js';

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

  // Confirm the job corresponds to a persisted deployment request.
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
    const now = new Date();

    const claimed = await tx.deployment.updateMany({
      where: {
        id: deploymentId,
        projectId,
        commitSha,
        OR: [
          {
            // First claim for a newly queued deployment.
            processingJobId: null,
            processingToken: null,
            status: { in: ['PENDING', 'QUEUED'] },
          },
          {
            // A later execution of the same job may replace its old claim.
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

    if (claimed.count !== 1) {
      return false;
    }

    // Check again while holding the database row lock.
    // Failure rolls back the claim.
    if ((await job.extendLock(queueToken, DEPLOYMENT_LOCK_DURATION_MS)) !== 1) {
      throw new Error('Deployment queue ownership was lost during claiming');
    }

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
