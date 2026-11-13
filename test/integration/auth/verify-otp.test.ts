import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prisma } from '../../../src/config/database.js';
import { createTestApp } from '../../support/apps.js';
import {
  differentCode,
  postVerifyOtp,
  requestOtpChallenge,
  signIn,
} from '../../support/auth-flow.js';
import { ERROR_MESSAGES, SESSION_COOKIE_NAME } from '../../support/constants.js';
import { requireSessionSetCookie, sessionTokenFromCookiePair } from '../../support/cookies.js';
import { expectError, expectStatus } from '../../support/http.js';
import { useTestData } from '../../support/test-data.js';

describe('POST /auth/verify-otp', () => {
  const data = useTestData();

  it('creates a new user and sets an HttpOnly session cookie', async () => {
    const testApp = createTestApp();
    const email = data.newEmail('verify');

    const { response, cookie } = await signIn(testApp, email);

    assert.equal(response.body.message, 'Email verification successful.');
    assert.equal(response.body.user.email, email);
    assert.equal(response.body.user.name, 'New User');
    assert.equal(response.body.user.onboardingCompletedAt, null);
    assert.match(response.body.user.username, /^[a-z]+_[0-9]{4}$/);
    assert.equal('code' in response.body, false);
    assert.equal('secure' in response.body, false);

    const setCookie = requireSessionSetCookie(response);

    assert.ok(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);

    // The session token must be in the cookie, never in the JSON body.
    const sessionToken = sessionTokenFromCookiePair(cookie);

    assert.ok(sessionToken.length > 0);
    assert.equal(
      JSON.stringify(response.body).includes(sessionToken),
      false,
      'The raw session token must not be returned in JSON',
    );
  });

  it('rejects reuse of an OTP that was already verified', async () => {
    const testApp = createTestApp();
    const { credentials } = await signIn(testApp, data.newEmail('verify'));

    const repeated = await postVerifyOtp(testApp.app, credentials);

    expectStatus(repeated, 400, 'Re-verifying a consumed OTP');
  });

  it('rejects an incorrect code and does not create a user', async () => {
    const testApp = createTestApp();
    const email = data.newEmail('wrong-code');
    const credentials = await requestOtpChallenge(testApp, email);

    const response = await postVerifyOtp(testApp.app, {
      ...credentials,
      code: differentCode(credentials.code),
    });

    expectError(response, 400, ERROR_MESSAGES.invalidOtp);
    assert.equal(await prisma.user.findUnique({ where: { email } }), null);
  });
});
