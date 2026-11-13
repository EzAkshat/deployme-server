import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectsCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import tar from 'tar-stream';

import { r2, r2BucketName } from '../config/r2.js';
import { validateArtifactArchive } from '../services/artifact-validation.js';
import { createArtifactObjectKey, createArtifactPrefix } from '../services/artifact-object.js';
import { publishArtifacts } from '../services/artifact-publisher.js';

async function main(): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'deployme-publish-check-'));

  const projectId = 'publisher-check';
  const deploymentId = randomUUID();
  const processingToken = randomUUID();

  const prefix = createArtifactPrefix(projectId, deploymentId, processingToken);

  const fixtures = [
    {
      name: 'index.html',
      content: '<!doctype html><h1>Hello from DeployMe!</h1>',
      mediaType: 'text/html',
    },
    {
      name: 'assets/style.css',
      content: 'body { color: navy; }',
      mediaType: 'text/css',
    },
  ];

  const keys = fixtures.map((file) => createArtifactObjectKey(prefix, file.name));

  let publishAttempted = false;

  try {
    const archivePath = path.join(workspace, 'artifacts.tar');
    const pack = tar.pack();

    for (const fixture of fixtures) {
      const body = Buffer.from(fixture.content);

      pack.entry(
        {
          name: `./${fixture.name}`,
          type: 'file',
          size: body.length,
        },
        body,
      );
    }

    pack.finalize();

    await pipeline(pack, createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));

    const files = await validateArtifactArchive(archivePath);
    console.log('Fixture archive validated.');

    publishAttempted = true;

    const result = await publishArtifacts({
      projectId,
      deploymentId,
      processingToken,
      archivePath,
      files,
    });

    assert.equal(result.artifactBucket, r2BucketName);
    assert.equal(result.artifactPrefix, prefix);
    assert.equal(result.fileCount, fixtures.length);
    assert.equal(
      result.totalFileBytes,
      fixtures.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    );

    console.log('Artifact files published to R2.');

    for (const fixture of fixtures) {
      const response = await r2.send(
        new GetObjectCommand({
          Bucket: r2BucketName,
          Key: createArtifactObjectKey(prefix, fixture.name),
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );

      const content = await response.Body?.transformToString();
      const validated = files.find((file) => file.path === fixture.name);

      assert.ok(validated);
      assert.equal(content, fixture.content);
      assert.equal(response.ContentLength, validated.size);
      assert.equal(response.ContentType?.split(';')[0], fixture.mediaType);
      assert.equal(response.Metadata?.sha256, validated.sha256);
    }

    console.log('File contents, content types, and hash metadata verified.');
  } finally {
    try {
      if (publishAttempted) {
        const cleanup = await r2.send(
          new DeleteObjectsCommand({
            Bucket: r2BucketName,
            Delete: {
              Objects: keys.map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
          { abortSignal: AbortSignal.timeout(30_000) },
        );

        if (cleanup.Errors?.length) {
          throw new Error(`Test cleanup failed for prefix: ${prefix}`);
        }

        console.log('R2 fixture objects removed.');
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      console.log('Temporary archive removed.');
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error('Artifact publisher check failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    r2.destroy();
  });
