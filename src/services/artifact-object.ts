import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import mime from 'mime-types';

import { r2, r2BucketName } from '../config/r2.js';
import type { ArtifactFile } from './artifact-validation.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function createArtifactPrefix(
  projectId: string,
  deploymentId: string,
  processingToken: string,
): string {
  for (const value of [projectId, deploymentId, processingToken]) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
      throw new Error('Invalid artifact storage identifier');
    }
  }

  return `projects/${projectId}/deployments/${deploymentId}/${processingToken}/`;
}

export function createArtifactObjectKey(prefix: string, filePath: string): string {
  if (
    !/^projects\/[a-zA-Z0-9_-]{1,128}\/deployments\/[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9_-]{1,128}\/$/.test(
      prefix,
    )
  ) {
    throw new Error('Invalid artifact storage prefix');
  }

  if (
    !filePath ||
    filePath.includes('\\') ||
    filePath.includes('\0') ||
    filePath.includes(':') ||
    filePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid artifact object path');
  }

  const key = `${prefix}${filePath}`;

  if (Buffer.byteLength(key, 'utf8') > 1_024) {
    throw new Error('Artifact object key exceeds the byte limit');
  }

  return key;
}

// The caller owns cleanup of this attempt's objects if publishing fails.
export async function uploadArtifactFile(
  prefix: string,
  file: ArtifactFile,
  body: Buffer,
  signal: AbortSignal,
): Promise<string> {
  const key = createArtifactObjectKey(prefix, file.path);

  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > MAX_FILE_BYTES ||
    body.length !== file.size
  ) {
    throw new Error(`Artifact size mismatch: ${file.path}`);
  }

  const sha256 = createHash('sha256').update(body).digest('hex');

  if (sha256 !== file.sha256) {
    throw new Error(`Artifact checksum mismatch: ${file.path}`);
  }

  const mediaType = mime.lookup(file.path) || 'application/octet-stream';
  const contentType = mime.contentType(mediaType) || mediaType;

  await r2.send(
    new PutObjectCommand({
      Bucket: r2BucketName,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: contentType,
      CacheControl: 'no-cache',
      Metadata: { sha256 },
    }),
    {
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    },
  );

  return key;
}
