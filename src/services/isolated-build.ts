import type { Container } from 'dockerode';
import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { docker } from '../config/docker.js';
import { BUILD_IMAGE, BUILD_LIMITS, type BuildRunnerInput } from './build-runner.js';
import { startBuildResourceCollection } from './build-resource-usage.js';
import { runContainerCommand } from './container-command.js';
import { copyRepositoryToContainer } from './container-source.js';
import { ContainerTimeoutError } from './container-lifecycle.js';
import { resolveContainerOutputPath } from './build-output-path.js';
import { downloadNpmTarballs } from './npm-tarball-downloader.js';

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

  // The downloader validates the lockfile before fetching any tarball.
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

  const npmTarballs =
    installCommand === 'npm ci'
      ? await prepareNpmTarballs(input.repositoryRoot, {
          deploymentId: input.deploymentId,
          processingToken: input.processingToken,
        })
      : null;

  let container: Container | undefined;
  let resourceCollector: Awaited<ReturnType<typeof startBuildResourceCollection>> | undefined;

  try {
    const tmpfs: Record<string, string> = {
      '/workspace': 'rw,nosuid,nodev,size=1g,mode=0700,uid=1000,gid=1000',
      '/tmp': 'rw,nosuid,nodev,size=128m,mode=1777',
    };

    const env = ['HOME=/tmp', 'CI=true'];
    const phases: string[] = [];

    if (npmTarballs) {
      tmpfs['/workspace'] += ',exec';
      tmpfs['/npm-cache'] = 'rw,nosuid,nodev,noexec,size=384m,mode=0700,uid=1000,gid=1000';

      env.push('npm_config_cache=/npm-cache');

      // Seed outside the repository so project-level npm settings do not
      // affect this step. One archive at a time keeps temporary usage lower.
      if (npmTarballs.files.length > 0) {
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
      Image: BUILD_IMAGE,
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
        Mounts: npmTarballs
          ? [
              {
                Type: 'bind',
                Source: npmTarballs.directory,
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

    await copyRepositoryToContainer(container, input.repositoryRoot);

    // Each phase gets its own subshell. The build starts from /workspace
    // even though cache seeding ran from /tmp.
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
      // Stop periodic sampling and save the final sample before removal.
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
        if (npmTarballs) {
          await rm(npmTarballs.directory, {
            recursive: true,
            force: true,
          });
        }
      }
    }
  }
}
