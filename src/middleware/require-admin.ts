import type { RequestHandler } from 'express';
import type { PlatformRole } from '../generated/prisma/client.js';
import { requireAuth } from './require-auth.js';

const ADMIN_ROLES: PlatformRole[] = ['SUPER_ADMIN', 'SITE_ADMIN'];

export const requireAdmin: RequestHandler[] = [
  requireAuth,
  (_req, res, next) => {
    const user = res.locals.authenticatedUser;

    if (!user || !ADMIN_ROLES.includes(user.platformRole)) {
      res.status(403).json({
        error: { message: 'Administrator access required.' },
      });
      return;
    }

    next();
  },
];
