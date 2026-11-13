import type { Container } from 'dockerode';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';

import { docker } from '../config/docker.js';
import { ContainerTimeoutError } from './container-lifecycle.js';

export class ContainerCommandExitError extends Error {
  constructor(public readonly exitCode: number) {
    super(`Container command failed with exit code ${exitCode}`);
    this.name = 'ContainerCommandExitError';
  }
}
interface CommandLogOptions {
  maxLogBytes: number;
  onLog: (stream: 'stdout' | 'stderr', text: string) => void;
}

// The caller must remove the container on failure or timeout.
export async function runContainerCommand(
  container: Container,
  command: string,
  timeoutMs: number,
  logs: CommandLogOptions,
): Promise<void> {
  if (!command.trim() || command.includes('\0')) {
    throw new Error('Container command must be non-empty and contain no null bytes');
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Command timeout must be a positive finite number');
  }

  if (!Number.isSafeInteger(logs.maxLogBytes) || logs.maxLogBytes <= 0) {
    throw new Error('Log limit must be a positive safe integer');
  }

  const deadline = performance.now() + timeoutMs;

  const execution = await container.exec({
    User: '1000:1000',
    WorkingDir: '/workspace',
    Tty: false,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Cmd: ['sh', '-c', command],
  });

  if (performance.now() >= deadline) {
    throw new ContainerTimeoutError(timeoutMs);
  }

  const connection = await execution.start({
    hijack: true,
    stdin: false,
  });

  let logBytes = 0;
  let failure: Error | undefined;

  const fail = (error: Error): void => {
    failure ??= error;
    connection.destroy(error);
  };

  const timeout = setTimeout(
    () => fail(new ContainerTimeoutError(timeoutMs)),
    Math.max(1, deadline - performance.now()),
  );

  const decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };

  function createLogSink(name: 'stdout' | 'stderr'): Writable {
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (!failure) {
          try {
            logBytes += chunk.length;

            if (logBytes > logs.maxLogBytes) {
              throw new Error('Container command exceeded the log-size limit');
            }

            const text = decoders[name].write(chunk);

            if (text) {
              logs.onLog(name, text);
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error('Build log handling failed'));
          }
        }

        callback();
      },
    });
  }

  const stdout = createLogSink('stdout');
  const stderr = createLogSink('stderr');

  try {
    const outputComplete = finished(connection, {
      readable: true,
      writable: false,
    });

    docker.modem.demuxStream(connection, stdout, stderr);

    await outputComplete;

    if (failure) {
      throw failure;
    }

    for (const name of ['stdout', 'stderr'] as const) {
      const remainingText = decoders[name].end();

      if (remainingText) {
        logs.onLog(name, remainingText);
      }
    }

    while (true) {
      if (failure) {
        throw failure;
      }

      if (performance.now() >= deadline) {
        throw new ContainerTimeoutError(timeoutMs);
      }

      const details = await execution.inspect();

      if (!details.Running && details.ExitCode !== null) {
        if (details.ExitCode !== 0) {
          throw new ContainerCommandExitError(details.ExitCode);
        }

        return;
      }

      await delay(100);
    }
  } finally {
    clearTimeout(timeout);
    connection.destroy();
    stdout.destroy();
    stderr.destroy();
  }
}
