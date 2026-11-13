import { Redis } from 'ioredis';

import { prisma } from '../config/database.js';
import { env } from '../config/env.js';

export type DatabaseProbe = () => Promise<unknown>;

const PROBE_TIMEOUT_MS = 3_000;
const CACHE_MS = 1_000;

let stopping = false;

let databaseQuery: Promise<unknown> | undefined;
let databaseCheck: Promise<boolean> | undefined;
let databaseCache: { ready: boolean; expiresAt: number } | undefined;

let redisCheck: Promise<boolean> | undefined;
let redisCache: { ready: boolean; expiresAt: number } | undefined;
let activeRedisProbe: Redis | undefined;

/**
 * Bounds the response time. This does not cancel the underlying operation.
 * The production database check below allows only one outstanding query.
 */
export async function checkDatabaseReadiness(
  probe: DatabaseProbe,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.resolve()
        .then(probe)
        .then(
          () => true,
          () => false,
        ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function runDatabaseQuery(): Promise<unknown> {
  if (!databaseQuery) {
    databaseQuery = Promise.resolve()
      .then(() => prisma.$queryRaw`SELECT 1`)
      .finally(() => {
        databaseQuery = undefined;
      });
  }

  return databaseQuery;
}

export async function getDatabaseReadiness(): Promise<boolean> {
  if (stopping) return false;

  if (databaseCache && databaseCache.expiresAt > Date.now()) {
    return databaseCache.ready;
  }

  if (!databaseCheck) {
    databaseCheck = checkDatabaseReadiness(runDatabaseQuery)
      .then((ready) => {
        databaseCache = {
          ready,
          expiresAt: Date.now() + CACHE_MS,
        };

        return ready;
      })
      .finally(() => {
        databaseCheck = undefined;
      });
  }

  return databaseCheck;
}

async function probeRedis(): Promise<boolean> {
  const client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    autoResendUnfulfilledCommands: false,
    retryStrategy: () => null,
  });

  activeRedisProbe = client;

  // Failures are returned as readiness status, not unhandled events.
  client.on('error', () => {});

  try {
    return await checkDatabaseReadiness(async () => {
      await client.connect();

      if ((await client.ping()) !== 'PONG') {
        throw new Error('Unexpected Redis readiness response');
      }
    });
  } finally {
    client.disconnect();

    if (activeRedisProbe === client) {
      activeRedisProbe = undefined;
    }
  }
}

export async function getRedisReadiness(): Promise<boolean> {
  if (stopping) return false;

  if (redisCache && redisCache.expiresAt > Date.now()) {
    return redisCache.ready;
  }

  if (!redisCheck) {
    redisCheck = probeRedis()
      .catch(() => false)
      .then((ready) => {
        redisCache = {
          ready,
          expiresAt: Date.now() + CACHE_MS,
        };

        return ready;
      })
      .finally(() => {
        redisCheck = undefined;
      });
  }

  return redisCheck;
}

export function stopReadinessChecks(): void {
  stopping = true;
  databaseCache = undefined;
  redisCache = undefined;
  activeRedisProbe?.disconnect();
}