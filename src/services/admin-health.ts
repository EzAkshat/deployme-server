import { getDatabaseReadiness, getRedisReadiness } from './readiness.js';
import { getWorkerPresence, WORKER_PRESENCE_TTL_MS } from './worker-presence.js';

export async function getAdminHealth() {
  const [databaseReady, redisReady, presence] = await Promise.all([
    getDatabaseReadiness(),
    getRedisReadiness(),
    getWorkerPresence(),
  ]);

  function workerStatus(count: number | undefined) {
    return {
      status:
        count === undefined
          ? ('unknown' as const)
          : count > 0
            ? ('present' as const)
            : ('absent' as const),
      count: count ?? null,
    };
  }

  const deployment = workerStatus(presence?.deployment);
  const outbox = workerStatus(presence?.outbox);

  const ready =
    databaseReady && redisReady && deployment.status === 'present' && outbox.status === 'present';

  return {
    collectedAt: new Date().toISOString(),
    status: ready ? ('ready' as const) : ('not_ready' as const),
    scope: 'dependency_connectivity_and_worker_presence' as const,
    probeCacheSeconds: 1,
    heartbeatTtlSeconds: WORKER_PRESENCE_TTL_MS / 1000,
    database: databaseReady ? ('connected' as const) : ('unavailable' as const),
    redis: redisReady ? ('connected' as const) : ('unavailable' as const),
    workers: {
      deployment,
      outbox,
    },
  };
}
