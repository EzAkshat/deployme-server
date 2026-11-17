import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { requireAuth } from '../middleware/require-auth.js';
import { canViewProject, ProjectAuthorizationError } from '../services/project-authorization.js';
import { ActivityInputError, getProjectActivity } from '../services/project-activity.js';
import { subscribeProjectActivity } from '../services/project-activity-listener.js';
import { activityDelta } from '../services/activity-delta.js';

export const projectActivityRouter = Router();
const querySchema = z
  .object({
    before: z.string().min(1).max(512).optional(),
    deployment: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
  })
  .strict()
  .refine((value) => !(value.before && value.deployment));
const activeStreams = new Map<number, number>();
let streamCount = 0;
function fail(res: Response, error: unknown) {
  const status =
    error instanceof ActivityInputError
      ? 400
      : error instanceof ProjectAuthorizationError
        ? 404
        : 503;
  res.status(status).json({
    error: {
      message:
        status === 400
          ? 'Invalid history cursor.'
          : status === 404
            ? 'Project not found or access denied.'
            : 'Project activity is temporarily unavailable.',
    },
  });
}

projectActivityRouter.get('/:projectId/activity', requireAuth, async (req, res) => {
  const query = querySchema.safeParse(req.query);
  const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
  if (!query.success || typeof projectId !== 'string' || !/^[\w-]{1,128}$/.test(projectId)) {
    res.status(400).json({ error: { message: 'Invalid project activity request.' } });
    return;
  }
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    res.json(await getProjectActivity(res.locals.authenticatedUser.id, projectId, query.data));
  } catch (error) {
    fail(res, error);
  }
});

projectActivityRouter.get('/:projectId/activity/stream', requireAuth, async (req, res) => {
  const query = querySchema.safeParse(req.query);
  const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
  if (!query.success || typeof projectId !== 'string' || !/^[\w-]{1,128}$/.test(projectId)) {
    res.status(400).json({ error: { message: 'Invalid project activity request.' } });
    return;
  }
  const input = query.data;
  const userId: number = res.locals.authenticatedUser.id;
  const sessionId: string = res.locals.authenticatedSessionId;
  try {
    if (!(await canViewProject(userId, projectId))) {
      res.status(404).json({ error: { message: 'Project not found or access denied.' } });
      return;
    }
  } catch (error) {
    fail(res, error);
    return;
  }
  if (streamCount >= 200 || (activeStreams.get(userId) ?? 0) >= 6) {
    res.setHeader('Retry-After', '10');
    res.status(429).end();
    return;
  }
  streamCount++;
  activeStreams.set(userId, (activeStreams.get(userId) ?? 0) + 1);
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let dirty = false;
  let checking = false;
  let previous: Awaited<ReturnType<typeof getProjectActivity>> | undefined;
  function close() {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    streamCount--;
    const remaining = (activeStreams.get(userId) ?? 1) - 1;
    if (remaining) activeStreams.set(userId, remaining);
    else activeStreams.delete(userId);
    res.end();
  }
  res.on('close', close);
  function unavailable() {
    if (!closed && res.headersSent) res.write('event: unavailable\ndata: {}\n\n');
    close(); // EventSource reconnects; first event will be a fresh database snapshot.
  }
  async function allowed() {
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    return session !== null && (await canViewProject(userId, projectId));
  }
  function accessLost() {
    if (!closed) res.write('event: access-lost\ndata: {}\n\n');
    close();
  }
  async function write(frame: string) {
    if (closed) return;
    if (res.write(frame)) return;
    // Bound buffered output for a slow/disconnected reader. No unbounded event queue.
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(() => {
        done();
        close();
      }, 10_000);
      function done() {
        clearTimeout(deadline);
        res.off('drain', done);
        res.off('close', done);
        resolve();
      }
      res.once('drain', done);
      res.once('close', done);
      if (closed) done();
    });
  }
  async function refresh() {
    if (closed || busy) return;
    busy = true;
    dirty = false;
    try {
      if (!(await allowed())) {
        accessLost();
        return;
      }
      const snapshot = await getProjectActivity(userId, projectId, input);
      // Recheck after potentially slow DB/storage reads, before disclosing data.
      if (closed) return;
      if (!(await allowed())) {
        accessLost();
        return;
      }
      if (!previous) {
        await write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      } else if (JSON.stringify(previous) !== JSON.stringify(snapshot)) {
        const delta = {
          ...snapshot,
          deployments: activityDelta(previous.deployments, snapshot.deployments),
        };
        await write(`event: update\ndata: ${JSON.stringify(delta)}\n\n`);
      }
      previous = snapshot;
    } catch (error) {
      if (error instanceof ProjectAuthorizationError) accessLost();
      else unavailable();
    } finally {
      busy = false;
      if (dirty && !closed) schedule();
    }
  }
  function schedule() {
    dirty = true;
    if (closed || busy || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, 150);
  }
  try {
    unsubscribe = await subscribeProjectActivity(projectId, {
      changed: schedule,
      unavailable,
    });
    if (closed) {
      unsubscribe();
      return;
    }
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    await refresh();
    if (closed) return;
    // Transport keepalive + access revalidation, NOT deployment/log polling.
    heartbeat = setInterval(() => {
      if (closed || checking || busy) return;
      checking = true;
      void allowed()
        .then(async (valid) => {
          if (!valid) accessLost();
          else await write(': keepalive\n\n');
        })
        .catch(unavailable)
        .finally(() => {
          checking = false;
        });
    }, 15_000);
    heartbeat.unref();
  } catch (error) {
    if (!closed && !res.headersSent) fail(res, error);
    close();
  }
});
