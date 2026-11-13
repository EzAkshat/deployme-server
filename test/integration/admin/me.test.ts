import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../../../src/app.js';
import { createSessionCookie } from '../../support/auth-flow.js';
import { ERROR_MESSAGES } from '../../support/constants.js';
import { expectError } from '../../support/http.js';
import { useTestData } from '../../support/test-data.js';

describe('GET /admin/me', () => {
  const data = useTestData();

  it('rejects requests without a session', async () => {
    const response = await request(app).get('/admin/me');

    expectError(response, 401, ERROR_MESSAGES.authRequired);
  });

  it('rejects an authenticated regular user', async () => {
    const user = await data.createUser({
      prefix: 'admin_test',
      name: 'Regular Test User',
      platformRole: 'USER',
    });
    const cookie = await createSessionCookie(user.id);

    const response = await request(app).get('/admin/me').set('Cookie', cookie);

    expectError(response, 403, ERROR_MESSAGES.adminRequired);
  });
});
