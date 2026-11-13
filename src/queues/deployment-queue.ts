import { Queue } from 'bullmq';
import { env } from '../config/env.js';

export const DEPLOYMENT_QUEUE_NAME = 'deployments';

export const deploymentQueue = new Queue(DEPLOYMENT_QUEUE_NAME, {
  connection: {
    ...(() => {
      const redisUrl = new URL(env.REDIS_URL);

      return {
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379),
        username: redisUrl.username || undefined,
        password: redisUrl.password || undefined,
        db: Number(redisUrl.pathname.slice(1) || 0),
        ...(redisUrl.protocol === 'rediss:' ? { tls: {} } : {}),
        maxRetriesPerRequest: null,
      };
    })(),
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2_000,
    },
    removeOnComplete: {
      age: 24 * 60 * 60,
    },
    removeOnFail: false,
  },
});
