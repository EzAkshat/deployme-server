import type { Container } from 'dockerode';
import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { docker } from '../config/docker.js';
import {
  BUILD_IMAGE,
  BUILD_LIMITS,
  PNPM_BUILD_IMAGE,
  PNPM_INSTALL_COMMAND,
  type BuildRunnerInput,
} from './build-runner.js';
import { startBuildResourceCollection } from './build-resource-usage.js';
import { runContainerCommand } from './container-command.js';
import { copyRepositoryToContainer } from './container-source.js';
import { ContainerTimeoutError } from './container-lifecycle.js';
import { resolveContainerOutputPath } from './build-output-path.js';
import { downloadNpmTarballs } from './npm-tarball-downloader.js';
import { preparePnpmBuildTarballs } from './pnpm-build-preparation.js';
import { publicBuildVariableEnvironment } from './public-build-variables.js';

async function prepareNpmTarballs(
  repositoryRoot: string,
  owner: Pick<BuildRunnerInput, 'deploymentId' | 'processingToken'>,
) {
  for (const filename of ['package.json', 'package-lock.json']) {
    const filePath = path.join(repositoryRoot, filename);
    const stats = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });

    if (!stats?.isFile()) {
      throw new Error(`npm ci requires a regular ${filename} in the project root.`);
    }
  }

  const lockfilePath = path.join(repositoryRoot, 'package-lock.json');
  const lockfile: unknown = JSON.parse(await readFile(lockfilePath, 'utf8'));

  return downloadNpmTarballs(lockfile, owner);
}

function remainingBuildTime(deadline: number): number {
  const remaining = Math.ceil(deadline - performance.now());

  if (remaining <= 0) {
    throw new ContainerTimeoutError(BUILD_LIMITS.timeoutMs);
  }

  return remaining;
}

export async function runIsolatedBuild(
  input: BuildRunnerInput,
  processOutput: (container: Container, outputPath: string) => Promise<void>,
): Promise<void> {
  if (input.installCommand.includes('\0') || input.buildCommand.includes('\0')) {
    throw new Error('Build commands must not contain null bytes');
  }

  const outputPath = resolveContainerOutputPath(input.outputDirectory);
  const installCommand = input.installCommand.trim();
  const deadline = performance.now() + BUILD_LIMITS.timeoutMs;
  const publicEnvironment = publicBuildVariableEnvironment(input.publicBuildVariables ?? {});
  const usesPnpm = installCommand === PNPM_INSTALL_COMMAND;

  const owner = {
    deploymentId: input.deploymentId,
    processingToken: input.processingToken,
  };

  const dependencyTarballs = usesPnpm
    ? await preparePnpmBuildTarballs(input.repositoryRoot, owner)
    : installCommand === 'npm ci'
      ? await prepareNpmTarballs(input.repositoryRoot, owner)
      : null;

  let container: Container | undefined;
  let resourceCollector: Awaited<ReturnType<typeof startBuildResourceCollection>> | undefined;

  try {
    const tmpfs: Record<string, string> = {
      '/workspace': 'rw,nosuid,nodev,size=1g,mode=0700,uid=1000,gid=1000',
      '/tmp': 'rw,nosuid,nodev,size=128m,mode=1777',
    };

    const env = ['HOME=/tmp', 'CI=true', ...publicEnvironment];
    const phases: string[] = [];

    if (usesPnpm && dependencyTarballs) {
      tmpfs['/workspace'] += ',exec';
      tmpfs['/pnpm-store'] = 'rw,nosuid,nodev,exec,size=384m,mode=0700,uid=1000,gid=1000';

      env.push(
        'XDG_CACHE_HOME=/tmp/cache',
        'XDG_CONFIG_HOME=/tmp/config',
        'XDG_DATA_HOME=/tmp/data',
        'COREPACK_ENABLE_NETWORK=0',
        'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
        'npm_config_cache=/tmp/npm-cache',
      );

      const pnpm = '/opt/deployme-tools/node_modules/.bin/pnpm';

      // Populate the private store from verified, read-only tarballs.
      // The container has no network access.
      if (dependencyTarballs.files.length > 0) {
        phases.push(`for archive in /tarballs/*.tgz; do
          ${pnpm} store add "$archive" \
            --store-dir /pnpm-store \
            --state-dir /tmp/pnpm-state \
            --reporter append-only || exit $?
        done`);
      }

      phases.push(
        [
          pnpm,
          'install',
          '--offline',
          '--frozen-lockfile',
          '--trust-lockfile',
          '--ignore-pnpmfile',
          '--no-runtime',
          '--store-dir /pnpm-store',
          '--state-dir /tmp/pnpm-state',
          '--node-linker isolated',
          '--reporter append-only',
        ].join(' '),
      );
    } else if (dependencyTarballs) {
      tmpfs['/workspace'] += ',exec';
      tmpfs['/npm-cache'] = 'rw,nosuid,nodev,noexec,size=384m,mode=0700,uid=1000,gid=1000';

      env.push('npm_config_cache=/npm-cache');

      // Seed outside the repository so project-level npm settings
      // do not affect cache preparation.
      if (dependencyTarballs.files.length > 0) {
        phases.push(`cd /tmp && for archive in /tarballs/*.tgz; do
          npm cache add --offline --cache /npm-cache "$archive" || exit $?
        done`);
      }

      phases.push('npm ci --offline --cache /npm-cache --no-audit --no-fund');
    } else {
      env.push('npm_config_cache=/tmp/npm-cache');

      if (installCommand) {
        phases.push(input.installCommand);
      }
    }

    if (input.buildCommand.trim()) {
      phases.push(input.buildCommand);
    }

    const lifetimeMs = remainingBuildTime(deadline);

    container = await docker.createContainer({
      Image: usesPnpm ? PNPM_BUILD_IMAGE : BUILD_IMAGE,
      User: '1000:1000',
      WorkingDir: '/workspace',
      NetworkDisabled: true,
      Labels: {
        'deployme.kind': 'build',
        'deployme.deployment-id': input.deploymentId,
        'deployme.processing-token': input.processingToken,
        'deployme.cleanup-version': '1',
      },
      Env: env,
      Cmd: ['node', '-e', `setTimeout(() => process.exit(124), ${lifetimeMs});`],
      HostConfig: {
        Init: true,
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: BUILD_LIMITS.memoryBytes,
        MemorySwap: BUILD_LIMITS.memoryBytes,
        NanoCpus: BUILD_LIMITS.cpus * 1_000_000_000,
        PidsLimit: BUILD_LIMITS.pids,
        Tmpfs: tmpfs,
        Mounts: dependencyTarballs
          ? [
              {
                Type: 'bind',
                Source: dependencyTarballs.directory,
                Target: '/tarballs',
                ReadOnly: true,
              },
            ]
          : [],
      },
    });

    await container.start();

    resourceCollector = await startBuildResourceCollection(
      container,
      input.deploymentId,
      input.processingToken,
    );

    await copyRepositoryToContainer(container, input.repositoryRoot, owner);

    // Each phase starts in /workspace in its own subshell.
    if (phases.length > 0) {
      const command = phases.map((phase) => `(\n${phase}\n)`).join(' &&\n');

      await runContainerCommand(container, command, remainingBuildTime(deadline), {
        maxLogBytes: BUILD_LIMITS.maxLogBytes,
        onLog: input.onLog,
      });
    }

    remainingBuildTime(deadline);

    await processOutput(container, outputPath);
  } finally {
    try {
      await resourceCollector?.close();
    } finally {
      try {
        if (container) {
          await container.remove({ force: true, v: true }).catch((error: unknown) => {
            // Another cleanup process may already have removed it.
            if (
              typeof error === 'object' &&
              error !== null &&
              'statusCode' in error &&
              error.statusCode === 404
            ) {
              return;
            }

            throw error;
          });
        }
      } finally {
        if (dependencyTarballs) {
          await rm(dependencyTarballs.directory, {
            recursive: true,
            force: true,
          });
        }
      }
    }
  }
}
