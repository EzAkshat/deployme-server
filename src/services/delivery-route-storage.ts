import { GetObjectCommand, PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';

import { r2, r2BucketName } from '../config/r2.js';
import { normalizeProjectSubdomain } from './project-subdomain.js';

export interface ActiveDeliveryRouteRecord {
  version: 1;
  projectId: string;
  deploymentId: string;
  deploymentCreatedAt: string;
  artifactPrefix: string;
  spaFallback: boolean;
}
export interface DisabledDeliveryRouteRecord {
  version: 1;
  projectId: string;
  disabled: true;
}

export type DeliveryRouteRecord =
  | ActiveDeliveryRouteRecord
  | DisabledDeliveryRouteRecord;

export function isDisabledDeliveryRoute(
  record: unknown,
): record is DisabledDeliveryRouteRecord {
  return (
    typeof record === 'object' &&
    record !== null &&
    'version' in record &&
    record.version === 1 &&
    'projectId' in record &&
    typeof record.projectId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(record.projectId) &&
    'disabled' in record &&
    record.disabled === true
  );
}

export interface StoredDeliveryRoute {
  etag: string;
  record: unknown;
}

function routeKey(subdomain: string): string {
  if (normalizeProjectSubdomain(subdomain) !== subdomain) {
    throw new Error('Invalid delivery subdomain');
  }

  return `_routes/${subdomain}.deployme.in.json`;
}

export async function readDeliveryRoute(subdomain: string): Promise<StoredDeliveryRoute | null> {
  const controller = new AbortController();

  try {
    const response = await r2.send(
      new GetObjectCommand({
        Bucket: r2BucketName,
        Key: routeKey(subdomain),
      }),
      {
        abortSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      },
    );

    if (
      !response.Body ||
      !response.ETag ||
      response.ContentLength === undefined ||
      response.ContentLength > 4_096
    ) {
      throw new Error('Invalid or oversized delivery routing record');
    }

    const text = await response.Body.transformToString();

    if (Buffer.byteLength(text, 'utf8') > 4_096) {
      throw new Error('Delivery routing record exceeds size limit');
    }

    const record: unknown = JSON.parse(text);

    return {
      etag: response.ETag,
      record,
    };
  } catch (error) {
    if (error instanceof S3ServiceException && error.name === 'NoSuchKey') {
      return null;
    }

    throw error;
  } finally {
    controller.abort();
  }
}

// Returns false if another writer changed or created the record.
// The caller must re-read and reconsider which deployment should win.
export async function writeDeliveryRoute(
  subdomain: string,
  record: DeliveryRouteRecord,
  previousEtag: string | null,
): Promise<boolean> {
  if (previousEtag !== null && previousEtag.length === 0) {
    throw new Error('An existing routing record requires an ETag');
  }

  const body = JSON.stringify(record);

  if (Buffer.byteLength(body, 'utf8') > 4_096) {
    throw new Error('Delivery routing record exceeds size limit');
  }

  try {
    await r2.send(
      new PutObjectCommand({
        Bucket: r2BucketName,
        Key: routeKey(subdomain),
        Body: body,
        ContentType: 'application/json',
        CacheControl: 'no-store',
        ...(previousEtag === null ? { IfNoneMatch: '*' } : { IfMatch: previousEtag }),
      }),
      { abortSignal: AbortSignal.timeout(15_000) },
    );

    return true;
  } catch (error) {
    if (
      error instanceof S3ServiceException &&
      (error.$metadata.httpStatusCode === 412 || error.$metadata.httpStatusCode === 409)
    ) {
      return false;
    }

    throw error;
  }
}
