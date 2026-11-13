import { S3Client } from '@aws-sdk/client-s3';
import { env } from './env.js';

const { R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;

if (!R2_BUCKET_NAME || !R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  throw new Error('R2 bucket, endpoint, and credentials must be configured');
}

export const r2BucketName = R2_BUCKET_NAME;

export const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  maxAttempts: 3,
});
