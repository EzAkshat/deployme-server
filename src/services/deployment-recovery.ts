import { reconcileDeploymentQueueItem } from "./deployment-recovery-item.js";
import { prisma } from '../config/database.js';
import { deploymentQueue } from '../queues/deployment-queue.js';
import { MAX_ATTEMPTS, CLAIM_LEASE_MS } from './deployment-outbox.js';

const BATCH_SIZE = 25;
// const MISSING_JOB_GRACE_MS = 15 * 60 * 1_000;

// Advance between polls so long-running deployments cannot starve later rows.
let scanAfterId: string | undefined;

export async function reconcileDeploymentQueueState(): Promise<number> {
  const candidates = await prisma.deployment.findMany({
    where: {
      status: { in: ['PENDING', 'QUEUED', 'BUILDING'] },
      ...(scanAfterId ? { id: { gt: scanAfterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take: BATCH_SIZE,
    select: { id: true },
  });

  const last = candidates[candidates.length - 1];
  scanAfterId = candidates.length === BATCH_SIZE && last ? last.id : undefined;

  let reconciled = 0;

  for (const candidate of candidates) {
    try {
      const changed = await reconcileDeploymentQueueItem(
        candidate.id,
        {
          getJob: (jobId) => deploymentQueue.getJob(jobId),
          maxDispatchAttempts: MAX_ATTEMPTS,
          claimLeaseMs: CLAIM_LEASE_MS,
        },
      );

      if (changed) {
        reconciled += 1;
      }
    } catch (error) {
      console.error('Deployment queue reconciliation failed.', {
        deploymentId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return reconciled;
}