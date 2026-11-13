import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../../../src/app.js';
import { ERROR_MESSAGES } from '../../support/constants.js';
import { expectError, expectStatus } from '../../support/http.js';
import { disconnectPrismaAfterAll } from '../../support/test-data.js';

describe('app basics', () => {
  disconnectPrismaAfterAll();

  it('GET / returns Hello World', async () => {
    const response = await request(app).get('/');

    expectStatus(response, 200);
    assert.equal(response.text, 'Hello World!');
  });

  it('GET /health returns a healthy status', async () => {
    const response = await request(app).get('/health');

    expectStatus(response, 200);
    assert.deepEqual(response.body, { status: 'ok' });
  });

  it('GET /ready reports database readiness', async () => {
    const response = await request(app).get('/ready');

    expectStatus(response, 200);
    assert.deepEqual(response.body, { status: 'ready', database: 'connected' });
  });

  it('returns a consistent 404 for unknown routes', async () => {
    const response = await request(app).get('/does-not-exist');

    expectError(response, 404, ERROR_MESSAGES.routeNotFound);
  });
});
