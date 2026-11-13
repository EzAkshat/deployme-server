import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Container } from 'dockerode';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TRANSFER_TIMEOUT_MS = 60_000;

export async function downloadBuildArtifacts(
  container: Container,
  outputPath: string,
  destination: string,
): Promise<number> {
  if (
    !path.posix.isAbsolute(outputPath) ||
    outputPath.includes('\0') ||
    outputPath.includes('\\')
  ) {
    throw new Error('Invalid container artifact path');
  }

  const normalized = path.posix.resolve(outputPath);

  if (normalized !== '/workspace' && !normalized.startsWith('/workspace/')) {
    throw new Error('Artifact path escapes the build workspace');
  }

  const file = await open(destination, 'wx', 0o600);
  let connection: Duplex | undefined;
  let archiveBytes = 0;
  let stderrBytes = 0;
  const stderrChunks: Buffer[] = [];

  async function* extractStdout(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    let pending: Buffer = Buffer.alloc(0);

    for await (const chunk of source) {
      pending = Buffer.concat([pending, chunk]);

      while (pending.length >= 8) {
        const streamType = pending[0];
        const size = pending.readUInt32BE(4);

        if (
          (streamType !== 1 && streamType !== 2) ||
          pending[1] !== 0 ||
          pending[2] !== 0 ||
          pending[3] !== 0
        ) {
          throw new Error('Invalid Docker output frame');
        }

        if (size > MAX_FRAME_BYTES) {
          throw new Error('Docker output frame exceeds the size limit');
        }

        if (pending.length < 8 + size) {
          break;
        }

        const payload = pending.subarray(8, 8 + size);
        pending = pending.subarray(8 + size);

        if (streamType === 1) {
          archiveBytes += payload.length;

          if (archiveBytes > MAX_ARCHIVE_BYTES) {
            throw new Error('Build artifact archive exceeds the size limit');
          }

          if (payload.length > 0) {
            yield payload;
          }
        } else {
          stderrBytes += payload.length;

          if (stderrBytes > MAX_STDERR_BYTES) {
            throw new Error('Artifact export exceeded the stderr limit');
          }

          stderrChunks.push(Buffer.from(payload));
        }
      }
    }

    if (pending.length !== 0) {
      throw new Error('Docker output ended with an incomplete frame');
    }
  }

  try {
    const signal = AbortSignal.timeout(TRANSFER_TIMEOUT_MS);

    const execution = await container.exec({
      User: '1000:1000',
      Tty: false,
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: [
        'tar',
        '--create',
        '--file=-',
        '--directory',
        normalized,
        '--exclude=.git',
        '--exclude=.hg',
        '--exclude=.svn',
        '--exclude=node_modules',
        '--exclude=.env',
        '--exclude=.env.*',
        '--exclude=.npmrc',
        '--exclude=.yarnrc',
        '--exclude=.yarnrc.yml',
        '--exclude=*.pem',
        '--exclude=*.key',
        '--',
        '.',
      ],
    });

    signal.throwIfAborted();

    connection = await execution.start({
      hijack: true,
      stdin: false,
    });

    await pipeline(connection, extractStdout, file.createWriteStream(), { signal });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      signal.throwIfAborted();

      const details = await execution.inspect();

      if (!details.Running && details.ExitCode !== null) {
        if (details.ExitCode !== 0) {
          const diagnostic = Buffer.concat(stderrChunks).toString('utf8').trim();

          throw new Error(
            `Artifact export failed with exit code ${details.ExitCode}` +
              (diagnostic ? `: ${diagnostic}` : ''),
          );
        }

        if (archiveBytes === 0) {
          throw new Error('Artifact export returned an empty stream');
        }

        return archiveBytes;
      }

      await delay(100);
    }

    throw new Error('Artifact export did not report completion');
  } catch (error) {
    connection?.destroy();
    await file.close();
    await rm(destination, { force: true });
    throw error;
  } finally {
    connection?.destroy();
    await file.close();
  }
}
