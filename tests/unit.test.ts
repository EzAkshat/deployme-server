import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { checkDatabaseReadiness } from '../src/services/readiness.js';

test('environment validation rejects an invalid PORT', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', 'import "./src/config/env.ts"'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: '70000',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Environment configuration validation failed/);
});

test('readiness returns true when the database probe succeeds', async () => {
  const result = await checkDatabaseReadiness(async () => 'connected');

  assert.equal(result, true);
});

test('readiness returns false when the database probe fails', async () => {
  const result = await checkDatabaseReadiness(async () => {
    throw new Error('Simulated database failure');
  });

  assert.equal(result, false);
});
