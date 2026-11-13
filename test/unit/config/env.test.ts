import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadEnvModule } from '../../support/env-process.js';

describe('environment validation', () => {
  it('rejects an invalid PORT', () => {
    const result = loadEnvModule({ PORT: '70000' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Environment configuration validation failed/);
  });
});
