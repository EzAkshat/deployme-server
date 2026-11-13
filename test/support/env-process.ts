import { spawnSync } from 'node:child_process';

/**
 * Imports `src/config/env.ts` in a fresh Node process (it validates and may
 * exit on import) with the given environment overrides.
 */
export function loadEnvModule(envOverrides: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', 'import "./src/config/env.ts"'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        ...envOverrides,
      },
    },
  );
}
