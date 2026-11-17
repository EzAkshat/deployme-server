import pg from 'pg';

type Subscriber = { changed: () => void; unavailable: () => void };
const subscribers = new Map<string, Set<Subscriber>>();
let client: pg.Client | undefined;
let connecting: Promise<void> | undefined;
let ready = false;
let stopped = false;

// One session-affine LISTEN connection per API process, not one per browser.
async function ensureListener(): Promise<void> {
  if (stopped) throw new Error('Activity listener is stopping');
  if (ready) return;
  if (connecting) return connecting;
  const current = new pg.Client({
    connectionString: process.env.REALTIME_DATABASE_URL ?? process.env.DATABASE_URL,
    application_name: 'deployme-activity-listener',
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  client = current;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let checking = false;
  function lost() {
    if (client !== current) return;
    ready = false;
    if (healthTimer) clearInterval(healthTimer);
    client = undefined;
    for (const group of [...subscribers.values()]) {
      for (const subscriber of [...group]) subscriber.unavailable();
    }
    void current.end().catch(() => {});
  }
  current.on('error', lost);
  current.on('end', () => {
    if (healthTimer) clearInterval(healthTimer);
    lost();
  });
  current.on('notification', (message) => {
    if (message.channel !== 'deployme_project_activity' || !message.payload) return;
    for (const subscriber of subscribers.get(message.payload) ?? []) subscriber.changed();
  });
  const operation = (async () => {
    try {
      await current.connect();
      // Fail explicitly if the migration has not been installed.
      const installed = await current.query(
        "SELECT 1 FROM pg_trigger WHERE tgname = 'deployme_deployment_activity' AND NOT tgisinternal",
      );
      if (!installed.rowCount) throw new Error('Apply the project activity migration first');
      await current.query('LISTEN deployme_project_activity');
      if (stopped || client !== current) throw new Error('Activity listener disconnected');
      ready = true;
      // Detect a half-open LISTEN socket. This does not read deployments or logs.
      healthTimer = setInterval(() => {
        if (checking || stopped) return;
        checking = true;
        void current
          .query('SELECT 1')
          .catch(lost)
          .finally(() => {
            checking = false;
          });
      }, 30_000);
      healthTimer.unref();
    } catch (error) {
      lost();
      throw error;
    }
  })();
  connecting = operation;
  try {
    await operation;
  } finally {
    connecting = undefined;
  }
}

export async function subscribeProjectActivity(projectId: string, subscriber: Subscriber) {
  await ensureListener();
  let group = subscribers.get(projectId);
  if (!group) {
    group = new Set();
    subscribers.set(projectId, group);
  }
  group.add(subscriber);
  // Caller reads its first snapshot AFTER subscription, closing the LISTEN/snapshot race.
  return () => {
    group.delete(subscriber);
    if (group.size === 0) subscribers.delete(projectId);
  };
}

export function stopProjectActivityListener(): void {
  stopped = true;
  ready = false;
  for (const group of [...subscribers.values()]) {
    for (const subscriber of [...group]) subscriber.unavailable();
  }
  subscribers.clear();
  const current = client;
  client = undefined;
  void current?.end().catch(() => {});
}
