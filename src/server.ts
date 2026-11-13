import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './config/database.js';
import { redisConnection } from './config/redis.js';
import { r2 } from './config/r2.js';
import { deploymentQueue } from './queues/deployment-queue.js';
import { stopReadinessChecks } from './services/readiness.js';
import app from './app.js';
import { stopWorkerPresenceChecks } from './services/worker-presence.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

const server = app.listen(env.PORT, () => {
  console.log(
    `DeployMe API listening on port ${env.PORT} (${env.NODE_ENV})`,
  );
});

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;

  stopping = true;
  stopReadinessChecks();
  stopWorkerPresenceChecks();
  console.log(`Received ${signal}; stopping DeployMe API...`);

  const deadline = setTimeout(() => {
    console.error('API shutdown timed out.');

    server.closeAllConnections();
    redisConnection.disconnect();
    r2.destroy();

    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });

      server.closeIdleConnections();
    });

    const results = await Promise.allSettled([
      deploymentQueue.close(),
      prisma.$disconnect(),
    ]);

    redisConnection.disconnect();
    r2.destroy();

    const failures = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected',
    );

    for (const failure of failures) {
      logger.error(
        { err: failure.reason },
        'API resource shutdown failed',
      );
    }

    clearTimeout(deadline);
    process.exit(failures.length > 0 ? 1 : 0);
  } catch (error: unknown) {
    logger.error({ err: error }, 'API shutdown failed');

    server.closeAllConnections();
    redisConnection.disconnect();
    r2.destroy();

    clearTimeout(deadline);
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));