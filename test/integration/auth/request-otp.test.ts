import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../../../src/app.js';
import { prisma } from '../../../src/config/database.js';
import { createTestApp } from '../../support/apps.js';
import { postRequestOtp } from '../../support/auth-flow.js';
import { ERROR_MESSAGES } from '../../support/constants.js';
import { expectError, expectStatus } from '../../support/http.js';
import { useTestData } from '../../support/test-data.js';

describe('POST /auth/request-otp', () => {
  const data = useTestData();

  it('rejects an invalid email', async () => {
    const response = await postRequestOtp(app, 'not-an-email');

    expectError(response, 400, ERROR_MESSAGES.invalidEmail);
  });

  it('sends an OTP email and never returns the code', async () => {
    const testApp = createTestApp();
    const email = data.newEmail('test');

    const response = await postRequestOtp(testApp.app, email);

    expectStatus(response, 200);
    assert.equal(testApp.sentOtps.length, 1);

    const [sent] = testApp.sentOtps;

    assert.ok(sent);
    assert.equal(sent.email, email);
    assert.match(sent.code, /^\d{6}$/);
    assert.equal(JSON.stringify(response.body).includes(sent.code), false);
    assert.match(response.body.message, /email will be sent shortly/i);
  });

  it('invalidates the challenge when email delivery fails', async () => {
    const testApp = createTestApp({
      onSendOtp: async () => {
        throw new Error('Simulated email provider failure');
      },
    });
    const email = data.newEmail('delivery-failure');

    const response = await postRequestOtp(testApp.app, email);

    expectError(response, 500, ERROR_MESSAGES.serverError);
    assert.equal(testApp.sentOtps[0]?.email, email.toLowerCase());

    const challenge = await prisma.otpChallenge.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });

    assert.ok(challenge);
    assert.ok(challenge.consumedAt, 'The undelivered challenge must be marked as consumed');
  });
});
