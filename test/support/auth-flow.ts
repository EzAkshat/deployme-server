import assert from 'node:assert/strict';
import type { Express } from 'express';
import request, { type Response } from 'supertest';
import { createSession } from '../../src/services/session.js';
import type { TestApp } from './apps.js';
import { TRUSTED_ORIGIN } from './constants.js';
import { requireSessionSetCookie, sessionCookieHeader, toCookiePair } from './cookies.js';
import { expectStatus } from './http.js';

export interface OtpCredentials {
  challengeId: string;
  email: string;
  code: string;
}

export interface SignedInSession {
  /** `deployme_session=<token>`, ready for `.set('Cookie', ...)`. */
  cookie: string;
  credentials: OtpCredentials;
  /** The `user` object from the verify-otp response. */
  user: { id: number; email: string; username: string; name: string };
  /** The raw verify-otp response, for tests that inspect headers or body. */
  response: Response;
}

export type VerifyEndpoint = '/auth/verify-otp' | '/auth/admin/verify-otp';

/** A six-digit code guaranteed to differ from `code`. */
export function differentCode(code: string): string {
  return code === '000000' ? '000001' : '000000';
}

export function postRequestOtp(app: Express, email: string) {
  return request(app).post('/auth/request-otp').set('Origin', TRUSTED_ORIGIN).send({ email });
}

export function postVerifyOtp(
  app: Express,
  credentials: OtpCredentials,
  endpoint: VerifyEndpoint = '/auth/verify-otp',
) {
  return request(app).post(endpoint).set('Origin', TRUSTED_ORIGIN).send(credentials);
}

/** Requests an OTP (asserting success) and returns the credentials needed to verify it. */
export async function requestOtpChallenge(
  testApp: TestApp,
  email: string,
): Promise<OtpCredentials> {
  const response = await postRequestOtp(testApp.app, email);

  expectStatus(response, 200, `OTP request for ${email}`);

  const challengeId: unknown = response.body.challengeId;

  assert.ok(
    typeof challengeId === 'string' && challengeId.length > 0,
    `OTP request should return a challenge ID. Response: ${JSON.stringify(response.body)}`,
  );

  return { challengeId, email, code: testApp.codeFor(email) };
}

/** Runs the full request-otp -> verify-otp flow and returns the session cookie. */
export async function signIn(testApp: TestApp, email: string): Promise<SignedInSession> {
  const credentials = await requestOtpChallenge(testApp, email);
  const response = await postVerifyOtp(testApp.app, credentials);

  expectStatus(response, 200, `OTP verification for ${email}`);

  const cookie = toCookiePair(
    requireSessionSetCookie(
      response,
      `Successful verification for ${email} should set a session cookie.`,
    ),
  );

  return { cookie, credentials, user: response.body.user, response };
}

/** Creates a session directly in the database, skipping the OTP flow. */
export async function createSessionCookie(userId: Parameters<typeof createSession>[0]) {
  const { token } = await createSession(userId);

  return sessionCookieHeader(token);
}
