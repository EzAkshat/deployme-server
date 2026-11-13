import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

import { env } from '../config/env.js';

type WorkerRole = 'deployment' | 'outbox';

export interface WorkerPresence {
  deployment: number;
  outbox: number;
}

const RENEW_INTERVAL_MS = 10_000;
export const WORKER_PRESENCE_TTL_MS = 45_000;

const READ_TIMEOUT_MS = 3_000;
const CACHE_MS = 1_000;

// All processes must use the same Redis database and this namespace.
const KEYS: Record<WorkerRole, string> = {
  deployment: 'deployme:presence:v1:{deployments}:deployment',
  outbox: 'deployme:presence:v1:{deployments}:outbox',
};

// Redis supplies the time, avoiding differences between host clocks.
const RENEW_SCRIPT = `
  local clock = redis.call('TIME')
  local now = tonumber(clock[1]) * 1000
    + math.floor(tonumber(clock[2]) / 1000)

  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)

  return 1
`;

const READ_SCRIPT = `
  local clock = redis.call('TIME')
  local now = tonumber(clock[1]) * 1000
    + math.floor(tonumber(clock[2]) / 1000)

  return {
    redis.call('ZCOUNT', KEYS[1], '(' .. now, '+inf'),
    redis.call('ZCOUNT', KEYS[2], '(' .. now, '+inf')
  }
`;

function createPresenceClient(reconnect: boolean): Redis {
  const client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    autoResendUnfulfilledCommands: false,
    retryStrategy: () => (reconnect ? 1_000 : null),
  });

  // Operations handle their own failures.
  client.on('error', () => {});

  return client;
}

export function startWorkerHeartbeat(
  role: WorkerRole,
  shouldAdvertise: () => boolean,
) {
  const instanceId = randomUUID();
  const client = createPresenceClient(true);
  const key = KEYS[role];

  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let failureLogged = false;

  function pulse(): void {
    if (stopped || inFlight || client.status !== 'ready') return;

    inFlight = (async () => {
      try {
        if (shouldAdvertise()) {
          await client.eval(
            RENEW_SCRIPT,
            1,
            key,
            instanceId,
            String(WORKER_PRESENCE_TTL_MS),
          );
        } else {
          await client.zrem(key, instanceId);
        }

        failureLogged = false;
      } catch (error: unknown) {
        if (!failureLogged && !stopped) {
          console.error('Worker heartbeat update failed.', {
            role,
            error: error instanceof Error ? error.message : String(error),
          });
          failureLogged = true;
        }
      }
    })().finally(() => {
      inFlight = undefined;
    });
  }

  const timer = setInterval(pulse, RENEW_INTERVAL_MS);
  timer.unref();

  client.on('ready', pulse);

  void client.connect().catch(() => {
    // Reconnection is enabled. A later ready event retries the heartbeat.
  });

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;

      clearInterval(timer);
      client.off('ready', pulse);

      try {
        // Finish an outstanding renewal before removing this instance.
        await inFlight;

        if (client.status === 'ready') {
          await client.zrem(key, instanceId);
        }
      } catch {
        // If Redis is unavailable, the heartbeat expires naturally.
      } finally {
        client.disconnect();
      }
    },
  };
}

let readsStopped = false;
let activeReader: Redis | undefined;
let readInFlight: Promise<WorkerPresence | null> | undefined;
let cachedRead:
  | { value: WorkerPresence | null; expiresAt: number }
  | undefined;

async function readPresence(): Promise<WorkerPresence | null> {
  const client = createPresenceClient(false);
  activeReader = client;

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const operation = (async (): Promise<WorkerPresence> => {
      await client.connect();

      const result: unknown = await client.eval(
        READ_SCRIPT,
        2,
        KEYS.deployment,
        KEYS.outbox,
      );

      if (!Array.isArray(result) || result.length !== 2) {
        throw new Error('Invalid worker heartbeat response');
      }

      const deployment: unknown = result[0];
      const outbox: unknown = result[1];

      if (
        typeof deployment !== 'number' ||
        !Number.isSafeInteger(deployment) ||
        deployment < 0 ||
        typeof outbox !== 'number' ||
        !Number.isSafeInteger(outbox) ||
        outbox < 0
      ) {
        throw new Error('Invalid worker heartbeat counts');
      }

      return { deployment, outbox };
    })();

    return await Promise.race([
      operation,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    client.disconnect();

    if (activeReader === client) {
      activeReader = undefined;
    }
  }
}

export async function getWorkerPresence(): Promise<WorkerPresence | null> {
  if (readsStopped) return null;

  if (cachedRead && cachedRead.expiresAt > Date.now()) {
    return cachedRead.value;
  }

  if (!readInFlight) {
    readInFlight = readPresence()
      .then((value) => {
        cachedRead = {
          value,
          expiresAt: Date.now() + CACHE_MS,
        };
        return value;
      })
      .finally(() => {
        readInFlight = undefined;
      });
  }

  return readInFlight;
}

export function stopWorkerPresenceChecks(): void {
  readsStopped = true;
  cachedRead = undefined;
  activeReader?.disconnect();
}