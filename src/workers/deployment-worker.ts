import { Worker, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path, { isAbsolute, relative, resolve, sep } from 'node:path';
import { buildProjectArtifacts } from '../services/project-build.js';
import { DEPLOYMENT_QUEUE_NAME } from '../queues/deployment-queue.js';
import { redisConnection } from '../config/redis.js';
import { prisma } from '../config/database.js';
import { downloadRepositoryArchive, getConnectedRepositoryForDeployment } from '../services/github-app.js';
import { extractRepositoryArchive } from '../services/archive-extractor.js';
import { publishArtifacts } from '../services/artifact-publisher.js';
import { ContainerTimeoutError } from '../services/container-lifecycle.js';
import { ContainerCommandExitError } from '../services/container-command.js';
import { DeploymentBuildSettingsError, readDeploymentBuildSettings } from '../services/deployment-build-settings.js';
import { createDeploymentLogCollector } from '../services/deployment-logs.js';
import { claimDeploymentExecution, DEPLOYMENT_LOCK_DURATION_MS } from '../services/deployment-claim.js';
import { createBuildTempDirectory } from '../services/build-temp-directory.js';
import { startWorkerHeartbeat } from '../services/worker-presence.js';
import { finalizeDeployment } from '../services/deployment-finalization.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function resolveProjectRoot(sourceDirectory: string, rootDirectory: string): string {
  if (
    rootDirectory.trim().length === 0 ||
    isAbsolute(rootDirectory) ||
    /^[a-zA-Z]:/.test(rootDirectory) ||
    rootDirectory.includes('\\') ||
    rootDirectory.includes('\0')
  ) {
    throw new Error('Project root directory must be a safe relative path');
  }

  const sourceRoot = resolve(sourceDirectory);
  const projectRoot = resolve(sourceRoot, rootDirectory);
  const relativePath = relative(sourceRoot, projectRoot);

  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Project root directory escapes the repository');
  }

  return projectRoot;
}

async function findRepositoryRoot(sourceDirectory: string): Promise<string> {
  const entries = await readdir(sourceDirectory, {
    withFileTypes: true,
  });

  if (entries.length === 0) {
    throw new Error('Extracted repository archive is empty');
  }

  const directories = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());

  if (files.length > 0) {
    return sourceDirectory;
  }

  // Unwrap the enclosing repository folder before applying rootDirectory.
  if (directories.length === 1) {
    return path.join(sourceDirectory, directories[0].name);
  }

  return sourceDirectory;
}
function resolveOutputDirectory(repositoryRoot: string, outputDirectory: string): string {
  if (
    outputDirectory.trim().length === 0 ||
    isAbsolute(outputDirectory) ||
    /^[a-zA-Z]:/.test(outputDirectory) ||
    outputDirectory.includes('\\') ||
    outputDirectory.includes('\0')
  ) {
    throw new Error('Output directory must be a safe relative path');
  }

  const projectRoot = resolve(repositoryRoot);
  const outputPath = resolve(projectRoot, outputDirectory);
  const relativePath = relative(projectRoot, outputPath);

  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Output directory escapes the project root');
  }

  return outputPath;
}
type DeploymentJobData = {
  deploymentId: string;
  projectId: string;
  commitSha: string;
  outboxEventId: string;
};

function isValidDeploymentJob(job: Job<DeploymentJobData>): boolean {
  const { deploymentId, projectId, commitSha, outboxEventId } = job.data;

  return (
    job.name === 'DEPLOYMENT_REQUESTED' &&
    typeof deploymentId === 'string' &&
    deploymentId.length > 0 &&
    typeof projectId === 'string' &&
    projectId.length > 0 &&
    typeof commitSha === 'string' &&
    /^[a-f0-9]{40}$/i.test(commitSha) &&
    typeof outboxEventId === 'string' &&
    outboxEventId.length > 0
  );
}
function getDeploymentFailureReason(error: unknown): string {
  if (error instanceof DeploymentBuildSettingsError) {
    return error.message;
  }
  if (error instanceof ContainerCommandExitError) {
    return `Install or build command exited with code ${error.exitCode}.`;
  }

  if (error instanceof ContainerTimeoutError) {
    return 'Deployment exceeded the build time limit.';
  }

  return 'Deployment failed during processing.';
}
async function processDeploymentJob(
  job: Job<DeploymentJobData>,
  queueToken?: string,
): Promise<void> {
  if (!isValidDeploymentJob(job)) {
    throw new Error('Invalid deployment job payload');
  }
  if (!queueToken) {
    throw new Error('Deployment queue ownership token is missing');
  }
  const { deploymentId, projectId, commitSha } = job.data;

  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      projectId: true,
      commitSha: true,
      status: true,
      processingToken: true,
      buildSettings: true,
    },
  });

  if (!deployment || deployment.projectId !== projectId) {
    throw new Error('Deployment not found or project mismatch');
  }

  if (deployment.commitSha !== commitSha) {
    throw new Error('Deployment commit SHA does not match the queued job');
  }

  if (
    deployment.status === 'CANCELLED' ||
    deployment.status === 'READY' ||
    deployment.status === 'FAILED'
  ) {
    console.log('Skipping deployment in terminal state.', {
      deploymentId,
      status: deployment.status,
    });
    return;
  }

  const processingToken = randomUUID();

  const claimed = await claimDeploymentExecution(job, queueToken, processingToken);

  if (!claimed) {
    const current = await prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { status: true },
    });

    if (
      current &&
      (current.status === 'CANCELLED' || current.status === 'READY' || current.status === 'FAILED')
    ) {
      return;
    }

    throw new Error('Deployment execution could not acquire database ownership');
  }

  let workspace: string | undefined;
  let logs: Awaited<ReturnType<typeof createDeploymentLogCollector>> | undefined;
  try {
    try {
      logs = await createDeploymentLogCollector(deploymentId, projectId, processingToken);
    } catch (error) {
      console.error('Deployment logs could not be initialized.', {
        deploymentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logs?.append(
      'system',
      `Starting queue execution ${job.attemptsStarted} ` +
        `(completed failed attempts: ${job.attemptsMade}) ` +
        `for commit ${commitSha}.`,
    );
    workspace = await createBuildTempDirectory('build', {
      deploymentId,
      processingToken,
    });
    const sourceDirectory = path.join(workspace, 'source');

    const buildSettings = readDeploymentBuildSettings(deployment.buildSettings);

    const repository = await getConnectedRepositoryForDeployment(projectId);

    if (!repository) {
      throw new Error('No connected GitHub repository found for this project');
    }

    if (repository.installation.installationId > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('GitHub installation ID is out of range');
    }

    const installationId = Number(repository.installation.installationId);

    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error('Invalid GitHub installation ID');
    }
    logs?.append('system', 'Downloading repository source.');
    const archive = await downloadRepositoryArchive(
      installationId,
      repository.owner,
      repository.name,
      commitSha,
    );

    console.log('GitHub repository archive downloaded.', {
      deploymentId,
      projectId,
      commitSha,
      archiveBytes: archive.length,
    });
    logs?.append('system', 'Extracting repository source.');
    await extractRepositoryArchive(archive, sourceDirectory);

    console.log('GitHub repository archive extracted.', {
      deploymentId,
      projectId,
      commitSha,
      sourceDirectory,
    });

    const extractedRepositoryRoot = await findRepositoryRoot(sourceDirectory);

    const repositoryRoot = resolveProjectRoot(extractedRepositoryRoot, buildSettings.rootDirectory);

    const rootStats = await stat(repositoryRoot);

    if (!rootStats.isDirectory()) {
      throw new Error('Configured project root must be a directory');
    }

    const outputPath = resolveOutputDirectory(repositoryRoot, buildSettings.outputDirectory);

    console.log('Project build paths resolved.', {
      deploymentId,
      repositoryRoot,
      outputPath,
    });
    logs?.append('system', 'Running build and validating output artifacts.');
    const result = await buildProjectArtifacts(
      {
        deploymentId,
        processingToken,
        repositoryRoot,
        installCommand: buildSettings.installCommand,
        buildCommand: buildSettings.buildCommand,
        outputDirectory: buildSettings.outputDirectory,
        onLog: (stream, text) => {
          logs?.append(stream, text);
        },
      },
      path.join(workspace, 'artifacts.tar'),
    );

    console.log('Deployment build and artifact validation completed.', {
      deploymentId,
      projectId,
      commitSha,
      archiveBytes: result.archiveBytes,
      fileCount: result.files.length,
      totalFileBytes: result.files.reduce((total, file) => total + file.size, 0),
    });
    logs?.append('system', 'Uploading validated artifacts.');
    const published = await publishArtifacts({
      projectId,
      deploymentId,
      processingToken,
      archivePath: result.archivePath,
      files: result.files,
    });
    logs?.append(
      'system',
      'Artifacts uploaded. Finalizing deployment; public routing follows separately.',
    );

    await logs?.close();
    console.log('Deployment artifacts uploaded.', {
      deploymentId,
      ...published,
    });

        await finalizeDeployment({
      deploymentId,
      projectId,
      processingToken,
      published,
      renewQueueLock: () =>
        job.extendLock(queueToken, DEPLOYMENT_LOCK_DURATION_MS),
    });
  } catch (error) {
    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
    logs?.append(
      'system',
      `${getDeploymentFailureReason(error)} ${
        isFinalAttempt ? 'No build attempts remain.' : 'Another build attempt will be queued.'
      }`,
    );

    await logs?.close();
    const released = await prisma.deployment.updateMany({
      where: {
        id: deploymentId,
        projectId,
        status: 'BUILDING',
        processingToken,
      },
      data: {
        status: isFinalAttempt ? 'FAILED' : 'QUEUED',
        failureReason: isFinalAttempt ? getDeploymentFailureReason(error) : null,
        buildFinishedAt: isFinalAttempt ? new Date() : null,
        processingToken: null,
        processingStartedAt: null,
      },
    });

    if (released.count !== 1) {
      throw new Error('Could not release deployment: processing ownership was lost');
    }

    throw error;
  } finally {
    await logs?.close();
    if (workspace) {
        await rm(workspace, {
          recursive: true,
          force: true,
        }).catch((cleanupError: unknown) => {
          console.error('Failed to clean deployment workspace.', {
            deploymentId,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
        });
      });
    }
  }
}

const worker = new Worker<DeploymentJobData>(DEPLOYMENT_QUEUE_NAME, processDeploymentJob, {
  connection: redisConnection,
  concurrency: 2,
  lockDuration: DEPLOYMENT_LOCK_DURATION_MS,
  stalledInterval: 30_000,
  maxStalledCount: 2,
});

worker.on('completed', (job) => {
  console.log(`Deployment job ${job.id} completed.`);
});

worker.on('failed', (job, error) => {
  console.error(`Deployment job ${job?.id ?? 'unknown'} failed:`, error.message);
});

worker.on('error', (error) => {
  console.error('Deployment worker error:', error.message);
});
worker.on('stalled', (jobId) => {
  console.warn('Deployment queue job stalled; recovery was scheduled.', {
    jobId,
  });
});
let shuttingDown = false;
const heartbeat = startWorkerHeartbeat(
  'deployment',
  () =>
    !shuttingDown &&
    redisConnection.status === 'ready' &&
    worker.isRunning() &&
    !worker.isPaused(),
);
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}; stopping deployment worker...`);

  const timeout = setTimeout(() => {
    console.error('Deployment worker shutdown timed out.');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  timeout.unref();

    try {
    await heartbeat.stop();
    await worker.close();
    await redisConnection.quit();
    await prisma.$disconnect();

    clearTimeout(timeout);
    process.exit(0);
  } catch (error) {
    console.error('Deployment worker shutdown failed:', error);
    clearTimeout(timeout);
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

console.log(`Deployment worker listening on queue "${DEPLOYMENT_QUEUE_NAME}".`);
