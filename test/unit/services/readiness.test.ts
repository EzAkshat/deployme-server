import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDatabaseReadiness } from '../../../src/services/readiness.js';

describe('checkDatabaseReadiness', () => {
  it('returns true when the database probe succeeds', async () => {
    assert.equal(await checkDatabaseReadiness(async () => 'connected'), true);
  });

  it('returns false when the database probe fails', async () => {
    const result = await checkDatabaseReadiness(async () => {
      throw new Error('Simulated database failure');
    });

    assert.equal(result, false);
  });
});
