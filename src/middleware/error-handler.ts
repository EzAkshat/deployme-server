import type { ErrorRequestHandler } from 'express';
import { AppError } from '../utils/app-error.js';
import { logger } from '../config/logger.js';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { message: err.message },
    });
    return;
  }

  logger.error({ err }, 'Unhandled application error');

  res.status(500).json({
    error: { message: 'Internal server error' },
  });
};
