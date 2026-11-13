import { docker } from '../config/docker.js';
import { prisma } from '../config/database.js';

const CLEANUP_INTERVAL_MS = 30_000;

let nextScanAt = 0;
let scanning = false;

function isAlreadyRemoved(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404
  );
}

export async function cleanupAbandonedBuildContainers(): Promise<number> {
  if (scanning || Date.now() < nextScanAt) return 0;

  scanning = true;

  try {
    const containers = await docker.listContainers({
      all: true,
      filters: JSON.stringify({
        label: ['deployme.kind=build', 'deployme.cleanup-version=1'],
      }),
    });

    let removed = 0;

    for (const container of containers) {
      const labels = container.Labels;
      const deploymentId = labels?.['deployme.deployment-id'];
      const processingToken = labels?.['deployme.processing-token'];

      if (!deploymentId || !processingToken) continue;

      try {
        const deployment = await prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: {
            status: true,
            processingToken: true,
          },
        });

        // Missing records are ambiguous: do not delete their containers.
        if (!deployment) continue;

        const isCurrentExecution =
          deployment.status === 'BUILDING' && deployment.processingToken === processingToken;

        if (isCurrentExecution) continue;

        // Tokens are unique per execution and are never reused.
        // A cleared or replaced token cannot become the current owner again.
        await docker.getContainer(container.Id).remove({ force: true, v: true });

        removed += 1;

        console.log('Removed abandoned build container.', {
          containerId: container.Id,
          deploymentId,
          deploymentStatus: deployment.status,
        });
      } catch (error) {
        if (isAlreadyRemoved(error)) continue;

        console.error('Build container cleanup failed.', {
          containerId: container.Id,
          deploymentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return removed;
  } finally {
    scanning = false;
    nextScanAt = Date.now() + CLEANUP_INTERVAL_MS;
  }
}
