import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../../../src/app.js';
import { TRUSTED_ORIGIN, UNTRUSTED_ORIGIN } from '../../support/constants.js';
import { expectStatus } from '../../support/http.js';
import { disconnectPrismaAfterAll } from '../../support/test-data.js';

describe('CORS', () => {
  disconnectPrismaAfterAll();

  it('allows the configured frontend origin', async () => {
    const response = await request(app).get('/health').set('Origin', TRUSTED_ORIGIN);

    expectStatus(response, 200);
    assert.equal(response.headers['access-control-allow-origin'], TRUSTED_ORIGIN);
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
  });

  it('does not grant access to an untrusted origin', async () => {
    const response = await request(app).get('/health').set('Origin', UNTRUSTED_ORIGIN);

    expectStatus(response, 200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
  });

  it('handles browser preflight requests', async () => {
    const response = await request(app)
      .options('/auth/request-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expectStatus(response, 204);
    assert.equal(response.headers['access-control-allow-origin'], TRUSTED_ORIGIN);
    assert.equal(response.headers['access-control-allow-credentials'], 'true');

    const allowedMethods = response.headers['access-control-allow-methods']
      .split(',')
      .map((method: string) => method.trim());

    assert.ok(allowedMethods.includes('POST'));
    assert.ok(
      response.headers['access-control-allow-headers'].toLowerCase().includes('content-type'),
    );
  });
});
