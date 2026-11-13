import assert from 'node:assert/strict';
import type { Response } from 'supertest';
import { SESSION_COOKIE_NAME } from './constants.js';

/** `Set-Cookie` may be a string or an array depending on the typings; always return an array. */
export function getSetCookieHeaders(response: Response): string[] {
  const value: string | string[] | undefined = response.headers['set-cookie'];

  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function findSessionSetCookie(response: Response): string | undefined {
  return getSetCookieHeaders(response).find((cookie) =>
    cookie.startsWith(`${SESSION_COOKIE_NAME}=`),
  );
}

export function requireSessionSetCookie(
  response: Response,
  message = 'Expected the response to set the session cookie.',
): string {
  const cookie = findSessionSetCookie(response);

  assert.ok(cookie, message);

  return cookie;
}

/** `deployme_session=abc; Path=/; HttpOnly` -> `deployme_session=abc` */
export function toCookiePair(setCookie: string): string {
  const pair = setCookie.split(';')[0];

  assert.ok(pair);

  return pair;
}

/** `deployme_session=abc` -> `abc` */
export function sessionTokenFromCookiePair(cookiePair: string): string {
  return cookiePair.slice(SESSION_COOKIE_NAME.length + 1);
}

/** Builds a `Cookie` request header value from a raw session token. */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`;
}
