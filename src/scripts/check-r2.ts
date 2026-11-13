import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { r2, r2BucketName } from '../config/r2.js';

async function main(): Promise<void> {
  const key = `_checks/${randomUUID()}.txt`;
  const content = 'Hello from DeployMe!';
  let uploaded = false;

  try {
    await r2.send(
      new PutObjectCommand({
        Bucket: r2BucketName,
        Key: key,
        Body: content,
        ContentType: 'text/plain; charset=utf-8',
      }),
      { abortSignal: AbortSignal.timeout(15_000) },
    );

    uploaded = true;
    console.log('R2 test file uploaded.');

    const response = await r2.send(
      new GetObjectCommand({
        Bucket: r2BucketName,
        Key: key,
      }),
      { abortSignal: AbortSignal.timeout(15_000) },
    );

    const downloaded = await response.Body?.transformToString();

    if (downloaded !== content) {
      throw new Error('Downloaded file contents do not match');
    }

    console.log('R2 file contents verified.');
  } finally {
    try {
      if (uploaded) {
        await r2.send(
          new DeleteObjectCommand({
            Bucket: r2BucketName,
            Key: key,
          }),
          { abortSignal: AbortSignal.timeout(15_000) },
        );

        console.log('R2 test file removed.');
      }
    } finally {
      r2.destroy();
    }
  }
}

main().catch((error: unknown) => {
  console.error('R2 check failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
