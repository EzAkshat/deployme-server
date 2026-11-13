import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../../../src/app.js';
import { createTestApp } from '../../support/apps.js';
import { signIn } from '../../support/auth-flow.js';
import { ERROR_MESSAGES, TRUSTED_ORIGIN } from '../../support/constants.js';
import { findSessionSetCookie } from '../../support/cookies.js';
import { expectError, expectStatus } from '../../support/http.js';
import { useTestData } from '../../support/test-data.js';

describe('auth session lifecycle', () => {
  const data = useTestData();

  it('GET /auth/me rejects requests without a session', async () => {
    const response = await request(app).get('/auth/me');

    expectError(response, 401, ERROR_MESSAGES.authRequired);
  });

  it('GET /auth/me returns the signed-in user', async () => {
    const testApp = createTestApp();
    const email = data.newEmail('me');
    const { cookie, user } = await signIn(testApp, email);

    const response = await request(testApp.app).get('/auth/me').set('Cookie', cookie);

    expectStatus(response, 200);
    assert.equal(response.body.user.id, user.id);
    assert.equal(response.body.user.email, email);
    assert.equal(response.body.user.username, user.username);
  });

  it('POST /auth/logout revokes the session and clears the cookie', async () => {
    const testApp = createTestApp();
    const { cookie } = await signIn(testApp, data.newEmail('logout'));

    const logout = await request(testApp.app)
      .post('/auth/logout')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', cookie);

    expectStatus(logout, 200);

    const clearedCookie = findSessionSetCookie(logout);

    assert.ok(clearedCookie, 'Expected the session cookie to be cleared');
    assert.match(clearedCookie, /HttpOnly/i);

    // The old cookie must no longer authenticate the user.
    const afterLogout = await request(testApp.app).get('/auth/me').set('Cookie', cookie);

    expectError(afterLogout, 401, ERROR_MESSAGES.authRequired);
  });
});
