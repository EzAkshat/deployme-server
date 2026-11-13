import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { prisma } from '../../../src/config/database.js';
import { createTestApp } from '../../support/apps.js';
import { differentCode, postVerifyOtp, requestOtpChallenge } from '../../support/auth-flow.js';
import { ERROR_MESSAGES } from '../../support/constants.js';
import { requireSessionSetCookie, toCookiePair } from '../../support/cookies.js';
import { expectError, expectStatus } from '../../support/http.js';
import { useTestData } from '../../support/test-data.js';

const ADMIN_VERIFY = '/auth/admin/verify-otp';

describe('POST /auth/admin/verify-otp', () => {
  const data = useTestData();

  it('does not create an account for an unknown email', async () => {
    const testApp = createTestApp({ mountAdmin: true });
    const email = data.newEmail('unknown-admin');
    const credentials = await requestOtpChallenge(testApp, email);

    const response = await postVerifyOtp(testApp.app, credentials, ADMIN_VERIFY);

    expectError(response, 403, ERROR_MESSAGES.notAdminAccount);
    assert.equal(await prisma.user.findUnique({ where: { email } }), null);
  });

  it('rejects an invalid OTP for an existing site admin', async () => {
    const testApp = createTestApp({ mountAdmin: true });
    const admin = await data.createUser({
      prefix: 'invalid_admin',
      name: 'Invalid OTP Test Admin',
      platformRole: 'SITE_ADMIN',
    });
    const credentials = await requestOtpChallenge(testApp, admin.email);

    const response = await postVerifyOtp(
      testApp.app,
      { ...credentials, code: differentCode(credentials.code) },
      ADMIN_VERIFY,
    );

    expectError(response, 400, ERROR_MESSAGES.invalidOtp);
  });

  it('authenticates an existing site admin who can then reach /admin/me', async () => {
    const testApp = createTestApp({ mountAdmin: true });
    const admin = await data.createUser({
      prefix: 'site_admin',
      name: 'Site Admin Test',
      platformRole: 'SITE_ADMIN',
    });
    const credentials = await requestOtpChallenge(testApp, admin.email);

    const verifyResponse = await postVerifyOtp(testApp.app, credentials, ADMIN_VERIFY);

    expectStatus(verifyResponse, 200, 'Admin OTP verification');
    assert.equal(verifyResponse.body.user.id, admin.id);
    assert.equal(verifyResponse.body.user.platformRole, 'SITE_ADMIN');

    const cookie = toCookiePair(requireSessionSetCookie(verifyResponse));
    const adminResponse = await request(testApp.app).get('/admin/me').set('Cookie', cookie);

    expectStatus(adminResponse, 200, 'GET /admin/me');
    assert.equal(adminResponse.body.user.id, admin.id);
    assert.equal(adminResponse.body.user.platformRole, 'SITE_ADMIN');
  });
});
