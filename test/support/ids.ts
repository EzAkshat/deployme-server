import { randomUUID } from 'node:crypto';

/** A unique, lowercase email such as `verify.<uuid>@example.com`. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomUUID()}@example.com`;
}

/** A unique username such as `session_1a2b3c4d5e6f`. */
export function uniqueUsername(prefix: string): string {
  const safePrefix = prefix.replaceAll(/[^a-zA-Z0-9_]/g, '_');

  return `${safePrefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}
