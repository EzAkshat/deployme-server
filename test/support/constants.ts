export const TRUSTED_ORIGIN = 'http://localhost:3000';
export const UNTRUSTED_ORIGIN = 'https://untrusted.example.com';
export const SESSION_COOKIE_NAME = 'deployme_session';

/** Number of wrong guesses after which an OTP challenge is locked. */
export const MAX_OTP_ATTEMPTS = 5;

/** User-facing API error messages. Change them here if the API copy changes. */
export const ERROR_MESSAGES = {
  authRequired: 'Authentication required.',
  adminRequired: 'Administrator access required.',
  notAdminAccount: 'This account is not authorized for administrator access.',
  invalidEmail: 'Please provide a valid email address.',
  invalidOtp: 'The code is invalid or expired. Please request a new code.',
  serverError: 'Unable to process your request right now. Please try again later.',
  routeNotFound: 'Route not found',
} as const;
