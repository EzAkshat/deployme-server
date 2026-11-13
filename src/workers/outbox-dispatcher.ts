import { dispatchDeploymentOutboxBatch } from '../services/deployment-outbox.js';
import { deploymentQueue } from '../queues/deployment-queue.js';
import { redisConnection } from '../config/redis.js';
import { prisma } from '../config/database.js';
import { processDeploymentRoutingOutbox } from '../services/deployment-routing-outbox.js';
import { r2 } from '../config/r2.js';
import { reconcileDeploymentQueueState } from '../services/deployment-recovery.js';
import { cleanupAbandonedBuildContainers } from '../services/build-container-cleanup.js';
import { processProjectArchiveOutbox } from '../services/project-archive-outbox.js';
import { cleanupAbandonedBuildTempDirectories } from '../services/build-temp-cleanup.js';
import { startWorkerHeartbeat } from '../services/worker-presence.js';

const POLL_INTERVAL_MS = 2_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let activePoll: Promise<void> | undefined;

const heartbeat = startWorkerHeartbeat(
  'outbox',
  () => !stopping && redisConnection.status === 'ready',
);

async function poll(): Promise<void> {
  if (stopping) return;

  const [
    dispatchResult,
    routingResult,
    recoveryResult,
    cleanupResult,
    archiveResult,
    tempCleanupResult,
  ] = await Promise.allSettled([
    dispatchDeploymentOutboxBatch(),
    processDeploymentRoutingOutbox(),
    reconcileDeploymentQueueState(),
    cleanupAbandonedBuildContainers(),
    processProjectArchiveOutbox(),
    cleanupAbandonedBuildTempDirectories(),
  ]);

  if (dispatchResult.status === 'fulfilled') {
    if (dispatchResult.value > 0) {
      console.log(`Dispatched ${dispatchResult.value} deployment outbox event(s).`);
    }
  } else {
    console.error('Deployment outbox dispatch failed:', dispatchResult.reason);
  }

  if (routingResult.status === 'rejected') {
    console.error('Deployment routing processing failed:', routingResult.reason);
  }

  if (recoveryResult.status === 'fulfilled') {
    if (recoveryResult.value > 0) {
      console.log(`Reconciled ${recoveryResult.value} unfinished deployment(s).`);
    }
  } else {
    console.error('Deployment recovery scan failed:', recoveryResult.reason);
  }

  if (cleanupResult.status === 'fulfilled') {
    if (cleanupResult.value > 0) {
      console.log(`Removed ${cleanupResult.value} abandoned build container(s).`);
    }
  } else {
    console.error('Build container cleanup failed:', cleanupResult.reason);
  }

  if (archiveResult.status === 'rejected') {
    console.error('Project archive processing failed:', archiveResult.reason);
  }
  if (tempCleanupResult.status === 'fulfilled') {
    if (tempCleanupResult.value > 0) {
      console.log(`Removed ${tempCleanupResult.value} abandoned build temporary folder(s).`);
    }
  } else {
    console.error('Build temporary-directory scan failed:', tempCleanupResult.reason);
  }
  if (!stopping) {
    timer = setTimeout(() => {
      timer = undefined;
      activePoll = poll();
    }, POLL_INTERVAL_MS);
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;

  stopping = true;
  console.log(`Received ${signal}; stopping outbox dispatcher...`);

  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }

  const timeout = setTimeout(() => {
    console.error('Dispatcher shutdown timed out.');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  timeout.unref();

    try {
    await heartbeat.stop();
    await activePoll;
    r2.destroy();
    await deploymentQueue.close();
    await redisConnection.quit();
    await prisma.$disconnect();

    clearTimeout(timeout);
    process.exit(0);
  } catch (error) {
    console.error('Dispatcher shutdown failed:', error);
    clearTimeout(timeout);
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

activePoll = poll();
