import { rateLimit } from 'express-rate-limit';

export function createInvitationResponseRateLimit() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (_req, res) => {
      // This middleware must run after requireAuth.
      const user = res.locals.authenticatedUser;

      if (!user) {
        throw new Error('Invitation rate limiter requires authentication.');
      }

      return `invitation-response:user:${user.id}`;
    },
    message: {
      error: {
        message:
          'Too many invitation attempts. Please wait 15 minutes before trying again.',
      },
    },
  });
}