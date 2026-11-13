import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { prisma } from '../../../src/config/database.js';
import { createTestApp } from '../../support/apps.js';
import { signIn } from '../../support/auth-flow.js';
import { TRUSTED_ORIGIN } from '../../support/constants.js';
import { expectStatus } from '../../support/http.js';
import { useTestData } from '../../support/test-data.js';

describe('PATCH /auth/onboarding', () => {
  const data = useTestData();

  it("saves the user's trimmed name and completes onboarding", async () => {
    const testApp = createTestApp();
    const { cookie, user } = await signIn(testApp, data.newEmail('onboarding'));

    const response = await request(testApp.app)
      .patch('/auth/onboarding')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', cookie)
      .send({ name: '  Akshat Naik  ' });

    expectStatus(response, 200);
    assert.equal(response.body.message, 'Onboarding completed successfully.');
    assert.equal(response.body.user.name, 'Akshat Naik');
    assert.ok(response.body.user.onboardingCompletedAt);
    assert.equal('token' in response.body, false);

    const savedUser = await prisma.user.findUnique({ where: { id: user.id } });

    assert.ok(savedUser);
    assert.equal(savedUser.name, 'Akshat Naik');
    assert.ok(savedUser.onboardingCompletedAt);
  });
});
