import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

export interface ArtifactFile {
  path: string;
  size: number;
  sha256: string;
}

export function normalizeArtifactPath(name: string): string {
  if (
    !name ||
    name.length > 1_024 ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.includes(':')
  ) {
    throw new Error('Artifact contains an unsafe path');
  }

  const segments = name.split('/');

  if (segments.includes('..')) {
    throw new Error('Artifact path contains parent-directory traversal');
  }

  return segments.filter((segment) => segment !== '' && segment !== '.').join('/');
}

export async function validateArtifactArchive(archivePath: string): Promise<ArtifactFile[]> {
  const extract = tar.extract();
  const files: ArtifactFile[] = [];
  const entries = new Map<string, 'file' | 'directory'>();

  let entryCount = 0;
  let totalBytes = 0;
  let archiveBytes = 0;

  const archiveLimiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      archiveBytes += chunk.length;

      if (archiveBytes > MAX_ARCHIVE_BYTES) {
        callback(new Error('Artifact archive exceeds the size limit'));
        return;
      }

      callback(null, chunk);
    },
  });

  extract.on('entry', (header, stream, next) => {
    void (async () => {
      entryCount += 1;

      if (entryCount > MAX_ENTRIES) {
        throw new Error('Artifact archive contains too many entries');
      }

      if (header.type !== 'file' && header.type !== 'directory') {
        throw new Error('Artifact archive contains a link or special file');
      }

      const entryPath = normalizeArtifactPath(header.name);
      const declaredSize = header.size ?? 0;

      if (
        !Number.isSafeInteger(declaredSize) ||
        declaredSize < 0 ||
        declaredSize > MAX_FILE_BYTES
      ) {
        throw new Error('Artifact entry has an invalid or excessive size');
      }

      if (header.type === 'directory' && declaredSize !== 0) {
        throw new Error('Artifact directory must not contain file data');
      }

      if (!entryPath && header.type !== 'directory') {
        throw new Error('Artifact file must have a non-empty path');
      }

      if (entries.has(entryPath)) {
        throw new Error('Artifact archive contains duplicate paths');
      }

      entries.set(entryPath, header.type);

      const hash = createHash('sha256');
      let actualSize = 0;

      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk)) {
          throw new Error('Artifact stream returned a non-buffer chunk');
        }

        actualSize += chunk.length;
        totalBytes += chunk.length;

        if (actualSize > declaredSize || totalBytes > MAX_TOTAL_BYTES) {
          throw new Error('Artifact contents exceed the size limits');
        }

        hash.update(chunk);
      }

      if (actualSize !== declaredSize) {
        throw new Error('Artifact entry size does not match its contents');
      }

      if (header.type === 'file') {
        files.push({
          path: entryPath,
          size: actualSize,
          sha256: hash.digest('hex'),
        });
      }

      next();
    })().catch((error: unknown) => {
      extract.destroy(error instanceof Error ? error : new Error('Artifact validation failed'));
    });
  });

  await pipeline(createReadStream(archivePath), archiveLimiter, extract, {
    signal: AbortSignal.timeout(60_000),
  });

  // Reject paths such as a file "assets" alongside "assets/app.js".
  for (const entryPath of entries.keys()) {
    const segments = entryPath.split('/');

    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join('/');

      if (entries.get(parent) === 'file') {
        throw new Error('Artifact contains conflicting file and directory paths');
      }
    }
  }

  if (files.length === 0) {
    throw new Error('Build output contains no files');
  }

  return files;
}
