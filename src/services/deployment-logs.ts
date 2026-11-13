import { StringDecoder } from 'node:string_decoder';

import { prisma } from '../config/database.js';
import { requireProjectPermission } from './project-authorization.js';

const MAX_LOG_BYTES = 256 * 1024;
const FLUSH_INTERVAL_MS = 2_000;

export async function createDeploymentLogCollector(
  deploymentId: string,
  projectId: string,
  processingToken: string,
) {
  // Read after claiming the deployment, preserving logs from earlier attempts.
  const deployment = await prisma.deployment.findFirst({
    where: {
      id: deploymentId,
      projectId,
      status: 'BUILDING',
      processingToken,
    },
    select: {
      logText: true,
      logTruncated: true,
    },
  });

  if (!deployment) {
    throw new Error('Cannot initialize logs: deployment ownership was lost');
  }

  let text = deployment.logText;
  let bytes = Buffer.byteLength(text, 'utf8');
  let truncated = deployment.logTruncated;
  let revision = 0;
  let savedRevision = 0;
  let closed = false;
  let ownershipLost = false;
  let inFlight: Promise<void> | undefined;

  function append(stream: 'system' | 'stdout' | 'stderr', value: string): void {
    if (closed || ownershipLost || truncated || !value) return;

    // PostgreSQL text cannot contain null characters.
    const cleaned = value.replace(/\0/g, '');
    if (!cleaned) return;

    const entry = `[${new Date().toISOString()}] [${stream}] ${cleaned}${
      cleaned.endsWith('\n') ? '' : '\n'
    }`;

    const encoded = Buffer.from(entry, 'utf8');
    const available = Math.max(0, MAX_LOG_BYTES - bytes);

    if (encoded.length > available) {
      // Omit an incomplete final UTF-8 character rather than corrupting it.
      const decoder = new StringDecoder('utf8');
      const prefix = decoder.write(encoded.subarray(0, available));

      text += prefix;
      bytes += Buffer.byteLength(prefix, 'utf8');
      truncated = true;
    } else {
      text += entry;
      bytes += encoded.length;
    }

    revision += 1;
  }

  async function flush(): Promise<void> {
    if (inFlight) {
      await inFlight;
      return flush();
    }

    if (ownershipLost || revision === savedRevision) return;

    const snapshotRevision = revision;
    const snapshot = {
      logText: text,
      logBytes: bytes,
      logTruncated: truncated,
      logUpdatedAt: new Date(),
    };

    const operation = (async () => {
      const result = await prisma.deployment.updateMany({
        where: {
          id: deploymentId,
          projectId,
          status: 'BUILDING',
          processingToken,
        },
        data: snapshot,
      });

      if (result.count !== 1) {
        ownershipLost = true;
        throw new Error('Cannot persist logs: deployment ownership was lost');
      }

      savedRevision = snapshotRevision;
    })();

    inFlight = operation;

    try {
      await operation;
    } finally {
      inFlight = undefined;
    }
  }

  function reportFlushFailure(): void {
    console.error('Deployment log persistence failed.', { deploymentId });
  }

  const timer = setInterval(() => {
    // Skip a tick if the previous write is still running.
    if (!inFlight && !ownershipLost) {
      void flush().catch(reportFlushFailure);
    }
  }, FLUSH_INTERVAL_MS);

  timer.unref();

  async function close(): Promise<void> {
    if (closed) return;

    closed = true;
    clearInterval(timer);

    // Finish any periodic write before attempting the final flush.
    if (inFlight) {
      await inFlight.catch(reportFlushFailure);
    }

    await flush().catch(reportFlushFailure);
  }

  return { append, close };
}

export async function getDeploymentLogs(userId: number, projectId: string, deploymentId: string) {
  await requireProjectPermission(userId, projectId, 'VIEW');

  return prisma.deployment.findFirst({
    where: { id: deploymentId, projectId },
    select: {
      id: true,
      status: true,
      failureReason: true,
      logText: true,
      logBytes: true,
      logTruncated: true,
      logUpdatedAt: true,
    },
  });
}
