import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import tar from 'tar-stream';

import { r2, r2BucketName } from '../config/r2.js';
import { normalizeArtifactPath, type ArtifactFile } from './artifact-validation.js';
import {
  createArtifactObjectKey,
  createArtifactPrefix,
  uploadArtifactFile,
} from './artifact-object.js';

interface PublishArtifactsInput {
  projectId: string;
  deploymentId: string;
  processingToken: string;
  archivePath: string;
  files: ArtifactFile[];
}

export interface PublishedArtifacts {
  artifactBucket: string;
  artifactPrefix: string;
  fileCount: number;
  totalFileBytes: number;
}

// Only pass keys belonging to this publishing attempt.
async function removeAttemptedObjects(keys: string[]): Promise<void> {
  const errors: unknown[] = [];

  for (let offset = 0; offset < keys.length; offset += 1_000) {
    try {
      const result = await r2.send(
        new DeleteObjectsCommand({
          Bucket: r2BucketName,
          Delete: {
            Objects: keys.slice(offset, offset + 1_000).map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );

      if (result.Errors?.length) {
        errors.push(new Error(`R2 could not remove ${result.Errors.length} artifact object(s)`));
      }
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Partial artifact cleanup failed');
  }
}

// The archive must remain in the worker's private workspace.
// files must be the result of validateArtifactArchive for this archive.
export async function publishArtifacts(input: PublishArtifactsInput): Promise<PublishedArtifacts> {
  const prefix = createArtifactPrefix(input.projectId, input.deploymentId, input.processingToken);

  const expected = new Map(input.files.map((file) => [file.path, { ...file }]));

  if (expected.size === 0 || expected.size !== input.files.length || expected.size > 10_000) {
    throw new Error('Invalid artifact file list');
  }

  let totalFileBytes = 0;

  // Check all object keys and limits before uploading anything.
  for (const file of expected.values()) {
    createArtifactObjectKey(prefix, file.path);

    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 50 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error('Invalid artifact file metadata');
    }

    totalFileBytes += file.size;
  }

  if (totalFileBytes > 500 * 1024 * 1024) {
    throw new Error('Artifacts exceed the total size limit');
  }

  const extract = tar.extract();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]);

  const attemptedKeys: string[] = [];
  const seen = new Set<string>();
  let uploadedFiles = 0;
  let entryCount = 0;
  let archiveBytes = 0;
  let pendingEntry: Promise<void> = Promise.resolve();

  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      archiveBytes += chunk.length;

      if (archiveBytes > 512 * 1024 * 1024) {
        callback(new Error('Artifact archive exceeds the size limit'));
        return;
      }

      callback(null, chunk);
    },
  });

  extract.on('entry', (header, stream, next) => {
    pendingEntry = (async () => {
      signal.throwIfAborted();
      entryCount += 1;

      if (entryCount > 10_000) {
        throw new Error('Artifact archive contains too many entries');
      }

      if (header.type !== 'file' && header.type !== 'directory') {
        throw new Error('Artifact contains a link or special file');
      }

      const entryPath = normalizeArtifactPath(header.name);

      if (seen.has(entryPath)) {
        throw new Error('Artifact archive contains duplicate paths');
      }

      seen.add(entryPath);

      const file = expected.get(entryPath);
      const isDirectory = header.type === 'directory';

      if (isDirectory) {
        if ((header.size ?? 0) !== 0 || file) {
          throw new Error('Invalid artifact directory');
        }
      } else if (!file || header.size !== file.size) {
        throw new Error('Archive no longer matches the validated file list');
      }

      const chunks: Buffer[] = [];
      let bytes = 0;
      const expectedSize = isDirectory ? 0 : file!.size;

      for await (const chunk of stream) {
        signal.throwIfAborted();

        if (!Buffer.isBuffer(chunk)) {
          throw new Error('Artifact stream returned a non-buffer chunk');
        }

        bytes += chunk.length;

        if (bytes > expectedSize) {
          throw new Error('Artifact file exceeds its validated size');
        }

        chunks.push(chunk);
      }

      if (bytes !== expectedSize) {
        throw new Error('Artifact file size mismatch');
      }

      if (!isDirectory && file) {
        const key = createArtifactObjectKey(prefix, file.path);

        // Include the key even if the upload response is lost.
        attemptedKeys.push(key);

        await uploadArtifactFile(prefix, file, Buffer.concat(chunks, bytes), signal);

        uploadedFiles += 1;
      }

      signal.throwIfAborted();
      next();
    })().catch((error: unknown) => {
      extract.destroy(error instanceof Error ? error : new Error('Artifact publishing failed'));
    });
  });

  try {
    await pipeline(createReadStream(input.archivePath), limiter, extract, { signal });

    await pendingEntry;
    signal.throwIfAborted();

    if (uploadedFiles !== expected.size) {
      throw new Error('Archive is missing validated artifact files');
    }

    return {
      artifactBucket: r2BucketName,
      artifactPrefix: prefix,
      fileCount: uploadedFiles,
      totalFileBytes,
    };
  } catch (error) {
    controller.abort();
    await pendingEntry;

    try {
      await removeAttemptedObjects(attemptedKeys);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Publishing and cleanup failed for ${prefix}`,
      );
    }

    throw error;
  }
}
