import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',

  redact: {
    paths: [
      'password',
      'token',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.otp',
      '*.password',
      '*.token',
    ],
    censor: '[REDACTED]',
  },

  transport:
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
          },
        }
      : undefined,
});
