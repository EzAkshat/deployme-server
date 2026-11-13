import express from 'express';
import { AppError } from './utils/app-error.js';
import { logger } from './config/logger.js';
import { prisma } from './config/database.js';
import { getDatabaseReadiness, getRedisReadiness } from './services/readiness.js';
import { authRouter } from './routes/auth.js';
import cors from 'cors';
import { env } from './config/env.js';
import { teamsRouter } from './routes/teams.js';
import { adminRouter } from './routes/admin.js';
import { projectsRouter } from './routes/projects.js';
import { githubWebhooksRouter } from './routes/github-webhooks.js';
import { githubIntegrationRouter } from './routes/github-integration.js';
import { getWorkerPresence, WORKER_PRESENCE_TTL_MS } from './services/worker-presence.js';
const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = [env.FRONTEND_ORIGIN ?? 'http://localhost:3000', env.ADMIN_ORIGIN]
        .filter((value): value is string => Boolean(value))
        .map((value) => new URL(value).origin);

      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, origin || false);
        return;
      }

      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key'],
  }),
);

app.use('/webhooks/github', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/auth', authRouter);
app.use('/teams', teamsRouter);
app.use('/admin', adminRouter);
app.use('/projects', projectsRouter);
app.use('/webhooks/github', githubWebhooksRouter);
app.use('/integrations/github', githubIntegrationRouter);

app.get('/', (_req, res) => {
  res.status(200).send('Hello World!');
});

app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  res.status(200).json({
    status: 'ok',
  });
});

app.get('/ready', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const databaseReady = await getDatabaseReadiness();

  res.status(databaseReady ? 200 : 503).json({
    status: databaseReady ? 'ready' : 'not_ready',
    database: databaseReady ? 'connected' : 'unavailable',
  });
});

app.get('/ready/deployments', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const [databaseReady, redisReady, presence] = await Promise.all([
    getDatabaseReadiness(),
    getRedisReadiness(),
    getWorkerPresence(),
  ]);

  const deploymentPresent =
    presence !== null && presence.deployment > 0;

  const outboxPresent =
    presence !== null && presence.outbox > 0;

  const ready =
    databaseReady &&
    redisReady &&
    deploymentPresent &&
    outboxPresent;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    database: databaseReady ? 'connected' : 'unavailable',
    redis: redisReady ? 'connected' : 'unavailable',
    scope: 'dependency_connectivity_and_worker_presence',
    heartbeatTtlSeconds: WORKER_PRESENCE_TTL_MS / 1_000,
    workers: {
      deployment: {
        status:
          presence === null
            ? 'unknown'
            : deploymentPresent
              ? 'present'
              : 'absent',
        count: presence?.deployment ?? null,
      },
      outbox: {
        status:
          presence === null
            ? 'unknown'
            : outboxPresent
              ? 'present'
              : 'absent',
        count: presence?.outbox ?? null,
      },
    },
  });
});

// Keep this AFTER all routes.
app.use((_req, res) => {
  res.status(404).json({
    error: {
      message: 'Route not found',
    },
  });
});

// Keep this AFTER the 404 handler.
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: {
          message: err.message,
        },
      });
      return;
    }

    logger.error({ err }, 'Unhandled application error');

    res.status(500).json({
      error: {
        message: 'Internal server error',
      },
    });
  },
);

export default app;
