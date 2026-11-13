import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const root = fileURLToPath(new URL('../', import.meta.url));
const envFile = path.join(root, '.env.test');
const config = parse(readFileSync(envFile));

const allowedKeys = new Set([
  'NODE_ENV',
  'DATABASE_URL',
  'REDIS_URL',
  'OTP_SECRET',
  'GITHUB_WEBHOOK_SECRET',
  'FRONTEND_ORIGIN',
  'ADMIN_ORIGIN',
  'R2_BUCKET_NAME',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]);

for (const key of Object.keys(config)) {
  if (!allowedKeys.has(key)) {
    throw new Error(`Unexpected setting in .env.test: ${key}`);
  }
}

function requireValue(key, expected) {
  if (config[key] !== expected) {
    throw new Error(`Unexpected test configuration for ${key}.`);
  }
}

requireValue('NODE_ENV', 'test');
requireValue(
  'DATABASE_URL',
  'postgresql://deployme_test:deployme_test_local@127.0.0.1:55432/deployme_test',
);
requireValue('REDIS_URL', 'redis://127.0.0.1:56379/0');
requireValue('R2_ENDPOINT', 'http://127.0.0.1:9');
requireValue('R2_BUCKET_NAME', 'deployme-test-artifacts');
requireValue('R2_ACCESS_KEY_ID', 'test-only-access-key');
requireValue('R2_SECRET_ACCESS_KEY', 'test-only-secret-key');

for (const key of ['OTP_SECRET', 'GITHUB_WEBHOOK_SECRET']) {
  if (!config[key] || config[key].length < 32) {
    throw new Error(`${key} must contain at least 32 characters.`);
  }
}

// Preserve operating-system settings, not inherited app credentials,
// NODE_OPTIONS, REAL_TEST_EMAIL, or development connection strings.
const systemKeys = new Set([
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'TERM',
]);

const childEnv = {};

for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && systemKeys.has(key.toUpperCase())) {
    childEnv[key] = value;
  }
}

Object.assign(childEnv, config, {
  // Both application config and prisma.config.ts import dotenv/config.
  // Redirect those imports to the test file, never the development file.
  DOTENV_CONFIG_PATH: envFile,
  DOTENV_CONFIG_QUIET: 'true',
});

function collectTests(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectTests(filename));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(filename);
    }
  }

  return files.sort();
}

const [mode = 'serial', ...extra] = process.argv.slice(2);
let args;

if (mode === 'migrate') {
  if (extra.length > 0) {
    throw new Error('The migrate command does not accept extra arguments.');
  }

  args = [
    path.join(root, 'node_modules/prisma/build/index.js'),
    'migrate',
    'deploy',
  ];
} else {
  const modes = new Set(['serial', 'parallel', 'unit', 'integration']);

  if (!modes.has(mode)) {
    throw new Error('Use serial, parallel, unit, integration, or migrate.');
  }

  const directories =
    mode === 'unit'
      ? ['test/unit']
      : mode === 'integration'
        ? ['test/integration']
        : ['test/unit', 'test/integration'];

  let files = directories.flatMap((directory) =>
    collectTests(path.join(root, directory)),
  );

  if (extra.length > 0) {
    const requested = new Set(
      extra.map((filename) => path.resolve(root, filename)),
    );
    const available = new Set(files);

    for (const filename of requested) {
      if (!available.has(filename)) {
        throw new Error('Requested file is outside the selected test suite.');
      }
    }

    files = files.filter((filename) => requested.has(filename));
  }

  if (files.length === 0) {
    throw new Error('No test files found.');
  }

  args = [
    '--import',
    'tsx',
    '--test',
    ...(mode === 'serial' ? ['--test-concurrency=1'] : []),
    ...files,
  ];
}

console.log(
  `[tests] ${mode}: PostgreSQL 127.0.0.1:55432/deployme_test; Redis 127.0.0.1:56379/0`,
);

const result = spawnSync(process.execPath, args, {
  cwd: root,
  env: childEnv,
  stdio: 'inherit',
  shell: false,
});

if (result.error) throw result.error;

if (result.signal) {
  console.error(`[tests] Child process stopped by ${result.signal}.`);
}

process.exitCode = result.status ?? 1;