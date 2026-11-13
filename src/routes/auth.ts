import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createOtpRateLimiters } from '../middleware/otp-rate-limit.js';
import { requireTrustedOrigin } from '../middleware/require-origin.js';
import { requireAuth } from '../middleware/require-auth.js';
import {
  createOtpChallenge,
  invalidateOtpChallenge,
  verifyOtpAndGetOrCreateUser,
  verifyOtpAndGetExistingUser,
} from '../services/otp-challenge.js';
import { sendOtpEmail } from '../services/email.js';
import { createSession, revokeSession, SESSION_COOKIE_NAME } from '../services/session.js';
import { prisma } from '../config/database.js';

type OtpEmailSender = (email: string, code: string) => Promise<void>;

export function createAuthRouter(sendEmail: OtpEmailSender = sendOtpEmail) {
  const authRouter = Router();
  const { otpRequestRateLimit, otpEmailRateLimit, otpVerifyRateLimit } = createOtpRateLimiters();
  const sessionCookieOptions = {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };

  const requestOtpSchema = z.object({
    email: z.string().trim().email().max(254),
  });

  const verifyOtpSchema = z.object({
    challengeId: z.string().min(1).max(128),
    email: z.string().trim().email().max(254),
    code: z.string().regex(/^\d{6}$/),
  });

  authRouter.post(
    '/request-otp',
    requireTrustedOrigin,
    otpRequestRateLimit,
    otpEmailRateLimit,
    async (req, res) => {
      const result = requestOtpSchema.safeParse(req.body);

      if (!result.success) {
        res.status(400).json({
          error: { message: 'Please provide a valid email address.' },
        });
        return;
      }

      let challengeId: string | undefined;

      try {
        const { challenge, code } = await createOtpChallenge(result.data.email);
        challengeId = challenge.id;

        await sendEmail(challenge.email, code);

        res.status(200).json({
          challengeId: challenge.id,
          message: 'If the address can receive a sign-in code, an email will be sent shortly.',
        });
      } catch (error: unknown) {
        if (challengeId) {
          try {
            await invalidateOtpChallenge(challengeId);
          } catch (invalidationError: unknown) {
            logger.error(
              { err: invalidationError },
              'Failed to invalidate OTP challenge after request failure',
            );
          }
        }

        logger.error('OTP request failed');

        res.status(500).json({
          error: {
            message: 'Unable to process your request right now. Please try again later.',
          },
        });
      }
    },
  );

  authRouter.post('/verify-otp', requireTrustedOrigin, otpVerifyRateLimit, async (req, res) => {
    const result = verifyOtpSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        error: {
          message: 'Please provide a valid challenge, email, and six-digit code.',
        },
      });
      return;
    }

    try {
      const user = await verifyOtpAndGetOrCreateUser(
        result.data.challengeId,
        result.data.email,
        result.data.code,
      );

      if (!user) {
        res.status(400).json({
          error: {
            message: 'The code is invalid or expired. Please request a new code.',
          },
        });
        return;
      }

      const session = await createSession(user.id);

      res.cookie(SESSION_COOKIE_NAME, session.token, {
        ...sessionCookieOptions,
        expires: session.expiresAt,
      });

      res.status(200).json({
        message: 'Email verification successful.',
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          email: user.email,
          onboardingCompletedAt: user.onboardingCompletedAt,
        },
      });
    } catch (error: unknown) {
      logger.error('OTP verification failed');

      res.status(500).json({
        error: {
          message: 'Unable to process your request right now. Please try again later.',
        },
      });
    }
  });

  authRouter.post(
    '/admin/verify-otp',
    requireTrustedOrigin,
    otpVerifyRateLimit,
    async (req, res) => {
      const result = verifyOtpSchema.safeParse(req.body);

      if (!result.success) {
        res.status(400).json({
          error: {
            message: 'Please provide a valid challenge, email, and six-digit code.',
          },
        });
        return;
      }

      try {
        const verification = await verifyOtpAndGetExistingUser(
          result.data.challengeId,
          result.data.email,
          result.data.code,
        );

        if (verification.status === 'INVALID_OTP') {
          res.status(400).json({
            error: {
              message: 'The code is invalid or expired. Please request a new code.',
            },
          });
          return;
        }

        if (verification.status === 'UNAUTHORIZED') {
          res.status(403).json({
            error: {
              message: 'This account is not authorized for administrator access.',
            },
          });
          return;
        }

        const user = verification.user;

        const session = await createSession(user.id);

        res.cookie(SESSION_COOKIE_NAME, session.token, {
          ...sessionCookieOptions,
          expires: session.expiresAt,
        });

        res.status(200).json({
          message: 'Administrator verification successful.',
          user: {
            id: user.id,
            username: user.username,
            name: user.name,
            email: user.email,
            platformRole: user.platformRole,
          },
        });
      } catch (error: unknown) {
        logger.error({ err: error }, 'Administrator OTP verification failed');

        res.status(500).json({
          error: {
            message: 'Unable to process your request right now. Please try again later.',
          },
        });
      }
    },
  );

  authRouter.get('/me', requireAuth, (_req, res) => {
    const user = res.locals.authenticatedUser;

    res.status(200).json({
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        onboardingCompletedAt: user.onboardingCompletedAt,
      },
    });
  });

  authRouter.patch('/onboarding', requireTrustedOrigin, requireAuth, async (req, res) => {
    const onboardingSchema = z.object({
      name: z.string().trim().min(1).max(100),
    });

    const result = onboardingSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        error: {
          message: 'Please provide a name between 1 and 100 characters.',
        },
      });
      return;
    }

    const authenticatedUser = res.locals.authenticatedUser;

    try {
      const updated = await prisma.user.updateMany({
        where: {
          id: authenticatedUser.id,
          onboardingCompletedAt: null,
        },
        data: {
          name: result.data.name,
          onboardingCompletedAt: new Date(),
        },
      });

      if (updated.count === 0) {
        res.status(409).json({
          error: {
            message: 'Onboarding has already been completed.',
          },
        });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: authenticatedUser.id },
        select: {
          id: true,
          username: true,
          name: true,
          email: true,
          onboardingCompletedAt: true,
        },
      });

      if (!user) {
        logger.error('User not found after onboarding update');

        res.status(500).json({
          error: {
            message: 'Unable to complete onboarding right now.',
          },
        });
        return;
      }

      res.status(200).json({
        message: 'Onboarding completed successfully.',
        user,
      });
    } catch (error: unknown) {
      logger.error({ err: error }, 'Onboarding completion failed');

      res.status(500).json({
        error: {
          message: 'Unable to complete onboarding right now.',
        },
      });
    }
  });

  authRouter.post('/logout', requireTrustedOrigin, async (req, res) => {
    try {
      const cookieHeader = req.headers.cookie;
      let token: string | undefined;

      if (cookieHeader) {
        for (const part of cookieHeader.split(';')) {
          const separator = part.indexOf('=');

          if (separator < 0) {
            continue;
          }

          const name = part.slice(0, separator).trim();

          if (name !== SESSION_COOKIE_NAME) {
            continue;
          }

          try {
            token = decodeURIComponent(part.slice(separator + 1).trim());
          } catch {
            token = undefined;
          }

          break;
        }
      }

      if (token) {
        await revokeSession(token);
      }

      res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions);

      res.status(200).json({
        message: 'Logged out successfully.',
      });
    } catch (error: unknown) {
      logger.error('Logout failed');

      res.status(500).json({
        error: {
          message: 'Unable to log out right now.',
        },
      });
    }
  });

  return authRouter;
}

export const authRouter = createAuthRouter();
