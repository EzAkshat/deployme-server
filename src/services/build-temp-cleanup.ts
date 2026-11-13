import { lstat, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { prisma } from '../config/database.js';
import { docker } from '../config/docker.js';
import { MANAGED_BUILD_TEMP_PATTERN } from './build-temp-directory.js';

const SCAN_INTERVAL_MS = 60_000;
const MINIMUM_AGE_MS = 60_000;
const BATCH_SIZE = 50;

let nextScanAt = 0;
let scanning = false;
let scanAfterName: string | undefined;

function errorCode(error: unknown): unknown {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error
    ? error.code
    : undefined;
}

function processDefinitelyGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    // Permission errors and other uncertainty must not authorize deletion.
    return errorCode(error) === 'ESRCH';
  }
}

export async function cleanupAbandonedBuildTempDirectories(): Promise<number> {
  if (scanning || Date.now() < nextScanAt) {
    return 0;
  }

  scanning = true;
  nextScanAt = Date.now() + SCAN_INTERVAL_MS;

  try {
    const root = os.tmpdir();
    const entries = await readdir(root, { withFileTypes: true });

    const names = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          MANAGED_BUILD_TEMP_PATTERN.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();

    const batch = names
      .filter((name) => !scanAfterName || name > scanAfterName)
      .slice(0, BATCH_SIZE);

    const last = batch[batch.length - 1];
    scanAfterName =
      batch.length === BATCH_SIZE && last ? last : undefined;

    let removed = 0;

    for (const name of batch) {
      try {
        const match = MANAGED_BUILD_TEMP_PATTERN.exec(name);

        if (!match) continue;

        const deploymentId = match[2];
        const processingToken = match[3];
        const rawPid = match[4];

        if (!deploymentId || !processingToken || !rawPid) continue;

        const pid = Number(rawPid);

        if (!processDefinitelyGone(pid)) continue;

        const directory = path.join(root, name);
        const before = await lstat(directory);

        if (!before.isDirectory() || before.isSymbolicLink()) continue;

        const createdAt =
          before.birthtimeMs > 0 ? before.birthtimeMs : before.mtimeMs;

        if (Date.now() - createdAt < MINIMUM_AGE_MS) continue;

        const deployment = await prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: {
            status: true,
            processingToken: true,
          },
        });

        // Missing records are ambiguous; leave their folders alone.
        if (!deployment) continue;

        const terminal =
          deployment.status === 'READY' ||
          deployment.status === 'FAILED' ||
          deployment.status === 'CANCELLED';

        // Recovery must release or replace the old execution first.
        if (!terminal && deployment.processingToken === processingToken) {
          continue;
        }

        // Even an exited container may retain a bind mount.
        // Wait until container cleanup removes it.
        const containers = await docker.listContainers({
          all: true,
          filters: {
            label: [
              'deployme.kind=build',
              `deployme.deployment-id=${deploymentId}`,
              `deployme.processing-token=${processingToken}`,
            ],
          },
        });

        if (containers.length > 0) continue;

        // Recheck the process and directory before deleting.
        if (!processDefinitelyGone(pid)) continue;

        const current = await lstat(directory);

        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.birthtimeMs !== before.birthtimeMs
        ) {
          continue;
        }

        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 2,
          retryDelay: 100,
        });

        removed += 1;

        console.log('Removed abandoned build temporary directory.', {
          deploymentId,
          directoryName: name,
        });
      } catch (error: unknown) {
        // Another cleanup process may already have removed the folder.
        if (errorCode(error) === 'ENOENT') continue;

        console.error('Build temporary-directory cleanup failed.', {
          directoryName: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return removed;
  } finally {
    scanning = false;
  }
}