
import { prisma } from "../config/database.js";

const MISSING_JOB_GRACE_MS = 15 * 60 * 1_000;

export interface RecoveryQueueJob {
  name: string;
  attemptsStarted: number;
  data: {
    outboxEventId?: unknown;
    deploymentId?: unknown;
    projectId?: unknown;
    commitSha?: unknown;
  } | null;
  getState(): Promise<string>;
}

export interface RecoveryOptions {
  getJob(jobId: string): Promise<RecoveryQueueJob | null | undefined>;
  maxDispatchAttempts: number;
  claimLeaseMs: number;
}

export async function reconcileDeploymentQueueItem(
  deploymentId: string,
  options: RecoveryOptions,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
        // Serialize this decision with worker claim/finalization updates.
        await tx.$queryRaw`
          SELECT "id"
          FROM "Deployment"
          WHERE "id" = ${deploymentId}
          FOR UPDATE
        `;

        const deployment = await tx.deployment.findUnique({
          where: { id: deploymentId },
          select: {
            id: true,
            projectId: true,
            commitSha: true,
            status: true,
            processingJobId: true,
            processingAttempt: true,
            processingToken: true,
            updatedAt: true,
          },
        });

        if (
          !deployment ||
          deployment.status === 'READY' ||
          deployment.status === 'FAILED' ||
          deployment.status === 'CANCELLED'
        ) {
          return false;
        }

        let jobId = deployment.processingJobId;

        if (!jobId) {
          const events = await tx.deploymentOutbox.findMany({
            where: {
              deploymentId: deployment.id,
              eventType: 'DEPLOYMENT_REQUESTED',
            },
            select: { id: true },
            take: 2,
          });

          // Do not guess ownership when multiple request events exist.
          if (events.length !== 1 || !events[0]) {
            return false;
          }

          jobId = `outbox-${events[0].id}`;
        }

        if (!jobId.startsWith('outbox-')) {
          throw new Error('Deployment has an invalid queue job identity');
        }

        const job = await options.getJob(jobId);

        if (!job) {
          // Check acknowledged dispatches and exhausted dispatch attempts.
          const event = await tx.deploymentOutbox.findFirst({
            where: {
              id: jobId.slice('outbox-'.length),
              deploymentId: deployment.id,
              eventType: 'DEPLOYMENT_REQUESTED',
            },
            select: {
              processedAt: true,
              claimToken: true,
              claimedAt: true,
              createdAt: true,
              attempts: true,
              payload: true,
            },
          });

          if (!event) {
            return false;
          }

          const now = Date.now();

          // Allow a dispatcher with a current lease to finish.
          // A claim without a timestamp needs separate inspection.
          if (
            event.claimToken !== null &&
            (
              event.claimedAt === null ||
              now - event.claimedAt.getTime() < options.claimLeaseMs
            )
          ) {
            return false;
          }

          const dispatchExhausted =
            event.processedAt === null && event.attempts >= options.maxDispatchAttempts;

          if (event.processedAt === null && !dispatchExhausted) {
            return false;
          }

          const payload = event.payload;

          if (
            !payload ||
            typeof payload !== 'object' ||
            Array.isArray(payload) ||
            payload.deploymentId !== deployment.id ||
            payload.projectId !== deployment.projectId ||
            payload.commitSha !== deployment.commitSha
          ) {
            throw new Error('Missing queue job has an invalid outbox request');
          }

          // Allow time after dispatch, the latest claim, and DB activity.
          const referenceTime = Math.max(
            event.processedAt?.getTime() ?? event.createdAt.getTime(),
            event.claimedAt?.getTime() ?? 0,
            deployment.updatedAt.getTime(),
          );

          if (now - referenceTime < MISSING_JOB_GRACE_MS) {
            return false;
          }

          // A Redis connection error must throw, not count as a missing job.
          if (await options.getJob(jobId)) {
            return false;
          }

          const result = await tx.deployment.updateMany({
            where: {
              id: deployment.id,
              status: deployment.status,
              processingToken: deployment.processingToken,
              processingJobId: deployment.processingJobId,
              processingAttempt: deployment.processingAttempt,
            },
            data: {
              status: 'FAILED',
              failureReason: dispatchExhausted
                ? 'Deployment could not be queued after repeated dispatch attempts. Request a new deployment.'
                : 'Deployment queue job is missing after dispatch. Request a new deployment.',
              processingToken: null,
              processingStartedAt: null,
              buildFinishedAt: new Date(),
            },
          });

          return result.count === 1;
        }

        const data = job.data;

        if (
          job.name !== 'DEPLOYMENT_REQUESTED' ||
          !data ||
          typeof data.outboxEventId !== 'string' ||
          jobId !== `outbox-${data.outboxEventId}` ||
          data.deploymentId !== deployment.id ||
          data.projectId !== deployment.projectId ||
          data.commitSha !== deployment.commitSha
        ) {
          throw new Error('Queue job does not match its deployment');
        }

        const matchingEvent = await tx.deploymentOutbox.findFirst({
          where: {
            id: data.outboxEventId,
            deploymentId: deployment.id,
            eventType: 'DEPLOYMENT_REQUESTED',
          },
          select: { id: true },
        });

        if (!matchingEvent) {
          throw new Error('Queue job has no matching deployment request');
        }

        // Never reconcile from a queue execution older than the DB claim.
        if (job.attemptsStarted < deployment.processingAttempt) {
          return false;
        }

        const state = await job.getState();

        if (state === 'failed' || state === 'completed') {
          const result = await tx.deployment.updateMany({
            where: {
              id: deployment.id,
              status: deployment.status,
              processingToken: deployment.processingToken,
              processingJobId: deployment.processingJobId,
              processingAttempt: deployment.processingAttempt,
            },
            data: {
              status: 'FAILED',
              failureReason:
                state === 'failed'
                  ? 'Deployment queue job failed before processing could finish. Request a new deployment.'
                  : 'Deployment queue job ended without a finalized deployment. Request a new deployment.',
              processingJobId: jobId,
              processingAttempt: job.attemptsStarted,
              processingToken: null,
              processingStartedAt: null,
              buildFinishedAt: new Date(),
            },
          });

          return result.count === 1;
        }

        if (
          deployment.processingJobId === null &&
          deployment.status === 'BUILDING' &&
          (state === 'waiting' || state === 'delayed' || state === 'active')
        ) {
          // Associate a legacy abandoned claim with its verified queue job.
          // A subsequent worker execution will assign a fresh token.
          const result = await tx.deployment.updateMany({
            where: {
              id: deployment.id,
              status: 'BUILDING',
              processingJobId: null,
              processingToken: deployment.processingToken,
              processingAttempt: deployment.processingAttempt,
            },
            data: {
              processingJobId: jobId,
            },
          });

          return result.count === 1;
        }

        return false;
  });
}
