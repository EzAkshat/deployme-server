import { Redis } from 'ioredis';
import { env } from './env.js';

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redisConnection.on('error', (error: Error) => {
  console.error('Redis connection error:', error.message);
});
