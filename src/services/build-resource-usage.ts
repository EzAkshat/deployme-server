import type { Container } from 'dockerode';

import { prisma } from '../config/database.js';

const SAMPLE_INTERVAL_MS = 2_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function startBuildResourceCollection(
  container: Container,
  deploymentId: string,
  processingToken: string,
): Promise<{ close(): Promise<void> } | undefined> {
  let warningLogged = false;

  function report(error: unknown): void {
    if (warningLogged) return;
    warningLogged = true;

    console.error('Build resource collection is incomplete.', {
      deploymentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    // Serialize initialization with deployment ownership changes.
    const initialized = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "Deployment"
        WHERE "id" = ${deploymentId}
        FOR UPDATE
      `;

      const deployment = await tx.deployment.findFirst({
        where: {
          id: deploymentId,
          status: 'BUILDING',
          processingToken,
        },
        select: { processingAttempt: true },
      });

      // Local runner scripts do not have a persisted deployment.
      if (!deployment || deployment.processingAttempt < 1) {
        return false;
      }

      await tx.deploymentResourceUsage.create({
        data: {
          deploymentId,
          processingToken,
          executionNumber: deployment.processingAttempt,
        },
      });

      return true;
    });

    if (!initialized) return undefined;
  } catch (error) {
    report(error);
    return undefined;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let closing = false;
  let ownershipLost = false;
  let hadError = false;

  let cpuTimeMs: number | null = null;
  let peakObservedMemoryBytes: number | null = null;
  let sampleCount = 0;
  let lastSampleAt: Date | null = null;

  async function persist(final: boolean): Promise<void> {
    const saved = await prisma.$transaction(async (tx) => {
      // The old execution cannot write after a replacement claims ownership.
      await tx.$queryRaw`
        SELECT "id"
        FROM "Deployment"
        WHERE "id" = ${deploymentId}
        FOR UPDATE
      `;

      const owner = await tx.deployment.findFirst({
        where: {
          id: deploymentId,
          status: 'BUILDING',
          processingToken,
        },
        select: { id: true },
      });

      if (!owner) return false;

      const result = await tx.deploymentResourceUsage.updateMany({
        where: {
          deploymentId,
          processingToken,
          finishedAt: null,
        },
        data: {
          cpuTimeMs,
          peakObservedMemoryBytes,
          sampleCount,
          lastSampleAt,
          ...(final
            ? {
                finishedAt: new Date(),
                collectionCompleted: !hadError && sampleCount > 0,
              }
            : {}),
        },
      });

      return result.count === 1;
    });

    if (!saved) ownershipLost = true;
  }

  async function sample(final: boolean): Promise<void> {
    if (ownershipLost) return;

    try {
      const options = {
        stream: false,
        'one-shot': true,
      } as const;

      const raw: unknown = await container.stats(options);
      const stats = asRecord(raw);
      const cpuStats = asRecord(stats.cpu_stats);
      const cpuUsage = asRecord(cpuStats.cpu_usage);
      const memoryStats = asRecord(stats.memory_stats);

      const cpuNanoseconds = readNonNegativeNumber(cpuUsage.total_usage);
      const memoryBytes = readNonNegativeNumber(memoryStats.usage);

      if (cpuNanoseconds === null || memoryBytes === null) {
        throw new Error('Docker returned incomplete CPU or memory statistics');
      }

      // Docker reports cumulative Linux container CPU time in nanoseconds.
      // Store the maximum observed counter, not a sum of repeated samples.
      cpuTimeMs = Math.max(cpuTimeMs ?? 0, cpuNanoseconds / 1_000_000);
      peakObservedMemoryBytes = Math.max(peakObservedMemoryBytes ?? 0, memoryBytes);

      sampleCount += 1;
      lastSampleAt = new Date();
    } catch (error) {
      hadError = true;
      report(error);
    }

    try {
      // Save prior successful samples even if this Docker read failed.
      await persist(final);
    } catch (error) {
      hadError = true;
      report(error);
    }
  }

  function schedule(): void {
    if (closing || ownershipLost) return;

    timer = setTimeout(() => {
      timer = undefined;

      // Schedule only after completion, preventing overlapping writes.
      inFlight = sample(false).finally(() => {
        inFlight = undefined;
        schedule();
      });
    }, SAMPLE_INTERVAL_MS);

    timer.unref();
  }

  await sample(false);
  schedule();

  return {
    close(): Promise<void> {
      if (!closePromise) {
        closing = true;

        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }

        closePromise = (async () => {
          await inFlight;
          await sample(true);
        })();
      }

      return closePromise;
    },
  };
}
