import type { RequestHandler } from 'express';
import { env } from '../config/env.js';

const allowedOrigins = new Set(
  [env.FRONTEND_ORIGIN ?? 'http://localhost:3000', env.ADMIN_ORIGIN]
    .filter((origin): origin is string => Boolean(origin))
    .map((origin) => new URL(origin).origin),
);

export const requireTrustedOrigin: RequestHandler = (req, res, next) => {
  const origin = req.get('origin');

  if (!origin || !allowedOrigins.has(origin)) {
    res.status(403).json({
      error: {
        message: 'Request origin is not allowed.',
      },
    });
    return;
  }

  next();
};
