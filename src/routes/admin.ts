import { Router } from 'express';
import { z } from 'zod';
import { listAdminUsers } from '../services/admin-users.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { getAdminOverview } from '../services/admin-overview.js';
import { requireTrustedOrigin } from '../middleware/require-origin.js';
import { AdminRoleChangeError, changeAdminUserRole } from '../services/admin-user-role.js';
import {
  AdminAuditHistoryInputError,
  getAdminAuditHistory,
} from '../services/admin-audit-history.js';
import { getAdminHealth } from '../services/admin-health.js';
import {
  AdminUserStatusError,
  changeAdminUserStatus,
  changeAdminUserStatusSchema,
} from '../services/admin-user-status.js';
import { listAdminProjects } from '../services/admin-projects.js';
import {
  AdminProjectDetailsError,
  getAdminProjectDetails,
} from '../services/admin-project-details.js';

const adminRouter = Router();

// Every route below requires an authenticated platform administrator.
adminRouter.use(requireAdmin);

adminRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

adminRouter.get('/me', (_req, res) => {
  const user = res.locals.authenticatedUser;

  res.status(200).json({
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      platformRole: user.platformRole,
    },
  });
});

adminRouter.get('/overview', async (_req, res, next) => {
  try {
    const overview = await getAdminOverview();

    res.status(200).json({ overview });
  } catch (error) {
    next(error);
  }
});

const listAdminUsersQuerySchema = z
  .object({
    after: z
      .string()
      .regex(/^[1-9]\d{0,9}$/)
      .transform(Number)
      .refine((value) => value <= 2_147_483_647, 'Invalid user cursor.')
      .optional(),

    search: z.string().trim().max(100).optional(),
  })
  .strict();

adminRouter.get('/users', async (req, res, next) => {
  const query = listAdminUsersQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({
      error: {
        message: 'Invalid user search or pagination cursor.',
      },
    });
    return;
  }

  try {
    const result = await listAdminUsers(query.data);

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

const adminUserIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .transform(Number)
  .refine((value) => value <= 2_147_483_647);

const changeAdminUserRoleSchema = z
  .object({
    expectedRole: z.enum(['USER', 'SITE_ADMIN']),
    nextRole: z.enum(['USER', 'SITE_ADMIN']),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();

adminRouter.patch('/users/:userId/role', requireTrustedOrigin, async (req, res, next) => {
  const actor = res.locals.authenticatedUser;
  const sessionId = res.locals.authenticatedSessionId;

  if (actor?.platformRole !== 'SUPER_ADMIN') {
    res.status(403).json({
      error: { message: 'Super administrator access required.' },
    });
    return;
  }

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    res.status(401).json({
      error: { message: 'Please sign in again.' },
    });
    return;
  }

  const target = adminUserIdSchema.safeParse(req.params.userId);
  const body = changeAdminUserRoleSchema.safeParse(req.body);

  if (!target.success || !body.success) {
    res.status(400).json({
      error: {
        message:
          'Provide a valid account, current role, new role, and a reason between 10 and 1000 characters.',
      },
    });
    return;
  }

  try {
    const result = await changeAdminUserRole({
      actorUserId: actor.id,
      sessionId,
      targetUserId: target.data,
      expectedRole: body.data.expectedRole,
      nextRole: body.data.nextRole,
      reason: body.data.reason,
    });

    res.status(200).json(result);
  } catch (error) {
    if (error instanceof AdminRoleChangeError) {
      res.status(error.status).json({
        error: { message: error.message },
      });
      return;
    }

    next(error);
  }
});

const adminAuditHistoryQuerySchema = z
  .object({
    before: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

adminRouter.get('/audit', async (req, res, next) => {
  const actor = res.locals.authenticatedUser;

  if (actor?.platformRole !== 'SUPER_ADMIN') {
    res.status(403).json({
      error: {
        message: 'Super administrator access required.',
      },
    });
    return;
  }

  const query = adminAuditHistoryQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({
      error: {
        message: 'Invalid audit history request.',
      },
    });
    return;
  }

  try {
    const result = await getAdminAuditHistory(query.data.before);

    res.status(200).json(result);
  } catch (error) {
    if (error instanceof AdminAuditHistoryInputError) {
      res.status(400).json({
        error: { message: error.message },
      });
      return;
    }

    next(error);
  }
});

adminRouter.get('/health', async (_req, res, next) => {
  try {
    const health = await getAdminHealth();

    // A successfully collected report returns 200 even when a
    // dependency is unavailable. Inspect health.status for readiness.
    res.status(200).json({ health });
  } catch (error) {
    next(error);
  }
});
adminRouter.patch('/users/:userId/status', requireTrustedOrigin, async (req, res, next) => {
  const actor = res.locals.authenticatedUser;
  const sessionId = res.locals.authenticatedSessionId;

  if (!actor || typeof sessionId !== 'string' || sessionId.length === 0) {
    res.status(401).json({
      error: { message: 'Please sign in again.' },
    });
    return;
  }

  const target = adminUserIdSchema.safeParse(req.params.userId);
  const body = changeAdminUserStatusSchema.safeParse(req.body);

  if (!target.success || !body.success) {
    res.status(400).json({
      error: {
        message:
          'Provide a valid account, current account version, suspension status, and a reason between 10 and 1000 characters.',
      },
    });
    return;
  }

  try {
    const result = await changeAdminUserStatus({
      actorUserId: actor.id,
      sessionId,
      targetUserId: target.data,
      ...body.data,
    });

    res.status(200).json(result);
  } catch (error) {
    if (error instanceof AdminUserStatusError) {
      res.status(error.status).json({
        error: { message: error.message },
      });
      return;
    }

    next(error);
  }
});
const listAdminProjectsQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    after: z.string().min(1).max(128).regex(/^[A-Za-z0-9]+$/).optional(),
  })
  .strict();

adminRouter.get('/projects', async (req, res, next) => {
  const query = listAdminProjectsQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({
      error: {
        message: 'Invalid project search or pagination cursor.',
      },
    });
    return;
  }

  try {
    const result = await listAdminProjects(query.data);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

const adminProjectDetailsParamsSchema = z.object({
  projectId: z.string().min(1).max(128).regex(/^[A-Za-z0-9]+$/),
});

const adminProjectDetailsQuerySchema = z
  .object({
    after: z.string().min(1).max(128).regex(/^[A-Za-z0-9]+$/).optional(),
  })
  .strict();

adminRouter.get('/projects/:projectId', async (req, res, next) => {
  const params = adminProjectDetailsParamsSchema.safeParse(req.params);
  const query = adminProjectDetailsQuerySchema.safeParse(req.query);

  if (!params.success || !query.success) {
    res.status(400).json({
      error: {
        message: 'Invalid project ID or deployment pagination cursor.',
      },
    });
    return;
  }

  try {
    const result = await getAdminProjectDetails(
      params.data.projectId,
      query.data,
    );

    res.status(200).json(result);
  } catch (error) {
    if (error instanceof AdminProjectDetailsError) {
      res.status(error.status).json({
        error: { message: error.message },
      });
      return;
    }

    next(error);
  }
});
export { adminRouter };
