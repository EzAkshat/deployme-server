import type { RequestHandler } from 'express';
import { SESSION_COOKIE_NAME, getActiveSession } from '../services/session.js';

function readCookie(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');

    if (separator < 0) continue;

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (name === cookieName) {
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }

  return null;
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);

    if (!token) {
      res.status(401).json({
        error: { message: 'Authentication required.' },
      });
      return;
    }

    const session = await getActiveSession(token);

    if (!session) {
      res.status(401).json({
        error: { message: 'Authentication required.' },
      });
      return;
    }

    res.locals.authenticatedUser = session.user;
    res.locals.authenticatedSessionId = session.id;
    next();
  } catch {
    res.status(500).json({
      error: { message: 'Unable to authenticate this request.' },
    });
  }
};
