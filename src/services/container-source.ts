import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Container } from 'dockerode';
import tar from 'tar-stream';

const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_PATH_LENGTH = 1_024;
const MAX_DEPTH = 64;

async function createSourceArchive(sourceRoot: string, archivePath: string): Promise<void> {
  const rootStats = await lstat(sourceRoot);

  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Source root must be a directory, not a symbolic link');
  }

  const pack = tar.pack();
  let entryCount = 0;
  let totalBytes = 0;

  const writeArchive = pipeline(
    pack,
    createWriteStream(archivePath, {
      flags: 'wx',
      mode: 0o600,
    }),
  );

  async function addDirectory(directory: string, segments: string[]): Promise<void> {
    if (segments.length > MAX_DEPTH) {
      throw new Error('Source directory nesting exceeds the limit');
    }

    const entries = await readdir(directory);

    for (const name of entries) {
      if (
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        name.includes('\\') ||
        name.includes(':') ||
        name.includes('\0')
      ) {
        throw new Error('Source contains an unsafe filename');
      }

      entryCount += 1;

      if (entryCount > MAX_ENTRIES) {
        throw new Error('Source contains too many entries');
      }

      const entrySegments = [...segments, name];
      const archiveName = entrySegments.join('/');

      if (archiveName.length > MAX_PATH_LENGTH) {
        throw new Error('Source path exceeds the length limit');
      }

      const entryPath = path.join(directory, name);
      const stats = await lstat(entryPath);

      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
        throw new Error('Source contains a symbolic link or special file');
      }

      let contents = Buffer.alloc(0);

      if (stats.isFile()) {
        if (stats.size > MAX_FILE_BYTES) {
          throw new Error('Source file exceeds the size limit');
        }

        if (totalBytes + stats.size > MAX_TOTAL_BYTES) {
          throw new Error('Source exceeds the total size limit');
        }

        contents = await readFile(entryPath);

        if (contents.length !== stats.size) {
          throw new Error('Source changed while preparing the archive');
        }

        totalBytes += contents.length;
      }

      await new Promise<void>((resolve, reject) => {
        pack.entry(
          {
            name: archiveName,
            type: stats.isDirectory() ? 'directory' : 'file',
            size: contents.length,
            mode: stats.isDirectory() ? 0o755 : 0o644,
            uid: 1000,
            gid: 1000,
            mtime: new Date(0),
          },
          contents,
          (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          },
        );
      });

      if (stats.isDirectory()) {
        await addDirectory(entryPath, entrySegments);
      }
    }
  }

  const produceArchive = (async () => {
    try {
      await addDirectory(sourceRoot, []);
      pack.finalize();
    } catch (error) {
      pack.destroy(error instanceof Error ? error : new Error('Source archive creation failed'));
      throw error;
    }
  })();

  // Wait for both operations to settle before deleting temporary files.
  const results = await Promise.allSettled([produceArchive, writeArchive]);

  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
}

export async function copyRepositoryToContainer(
  container: Container,
  repositoryRoot: string,
): Promise<void> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'deployme-source-'));

  try {
    const archivePath = path.join(temporaryDirectory, 'source.tar');

    await createSourceArchive(path.resolve(repositoryRoot), archivePath);

    const extraction = await container.exec({
      User: '1000:1000',
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: [
        'tar',
        '--extract',
        '--file=-',
        '--directory=/workspace',
        '--no-same-owner',
        '--no-same-permissions',
      ],
    });

    const connection = await extraction.start({
      hijack: true,
      stdin: true,
    });

    const archiveStream = createReadStream(archivePath);

    // Forward source-read failures to the connection we are awaiting.
    archiveStream.once('error', (error) => {
      connection.destroy(error);
    });

    try {
      const completed = finished(connection, {
        readable: true,
        writable: false,
        signal: AbortSignal.timeout(20_000),
      });

      // Drain Docker's output stream so extraction cannot block on output.
      connection.resume();

      // Ending stdin tells tar that the archive has finished.
      archiveStream.pipe(connection);

      await completed;

      if (!archiveStream.readableEnded) {
        throw new Error('Archive transfer ended before all source bytes were sent');
      }

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const details = await extraction.inspect();

        if (!details.Running && details.ExitCode !== null) {
          if (details.ExitCode !== 0) {
            throw new Error(`Source extraction failed with exit code ${details.ExitCode}`);
          }

          return;
        }

        await delay(250);
      }

      throw new Error('Source extraction did not report completion');
    } finally {
      archiveStream.unpipe(connection);
      archiveStream.destroy();
      connection.destroy();
    }
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}
