import { createHash } from 'node:crypto';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

const WINDOW_MS = 15 * 60 * 1000;

export function createOtpRateLimiters() {
  const otpRequestRateLimit = rateLimit({
    windowMs: WINDOW_MS,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        message: 'Too many OTP requests. Please try again later.',
      },
    },
  });

  const otpEmailRateLimit = rateLimit({
    windowMs: WINDOW_MS,
    limit: 3,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

      if (!email) {
        return `ip:${ipKeyGenerator(req.ip ?? '127.0.0.1')}`;
      }

      const emailHash = createHash('sha256').update(email).digest('hex');

      return `email:${emailHash}`;
    },
    message: {
      error: {
        message: 'Too many OTP requests. Please try again later.',
      },
    },
  });

  const otpVerifyRateLimit = rateLimit({
    windowMs: WINDOW_MS,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        message: 'Too many verification attempts. Please try again later.',
      },
    },
  });

  return {
    otpRequestRateLimit,
    otpEmailRateLimit,
    otpVerifyRateLimit,
  };
}
