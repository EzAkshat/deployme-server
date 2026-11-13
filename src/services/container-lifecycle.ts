import type { Container } from 'dockerode';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

export class ContainerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Container exceeded its ${timeoutMs} ms execution limit`);
    this.name = 'ContainerTimeoutError';
  }
}

// The caller must remove the container in a finally block.
export async function waitForContainerExit(
  container: Container,
  timeoutMs: number,
): Promise<number> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Container timeout must be a positive finite number');
  }

  const deadline = performance.now() + timeoutMs;

  while (true) {
    const remainingMs = deadline - performance.now();

    if (remainingMs <= 0) {
      throw new ContainerTimeoutError(timeoutMs);
    }

    const details = await container.inspect();

    if (!details.State.Running) {
      return details.State.ExitCode;
    }

    await delay(Math.min(500, remainingMs));
  }
}
