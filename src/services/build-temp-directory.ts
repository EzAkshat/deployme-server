import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface BuildTempOwner {
  deploymentId: string;
  processingToken: string;
}

const SAFE_PART = /^[A-Za-z0-9_-]{1,64}$/;

// Fields are separated by dots, which SAFE_PART does not permit.
export const MANAGED_BUILD_TEMP_PATTERN =
  /^deployme-(build|npm)-v1\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,64})\.([1-9]\d*)\.([A-Za-z0-9]{6})$/;

export async function createBuildTempDirectory(
  kind: 'build' | 'npm',
  owner: BuildTempOwner,
): Promise<string> {
  if (
    !SAFE_PART.test(owner.deploymentId) ||
    !SAFE_PART.test(owner.processingToken)
  ) {
    throw new Error('Invalid build temporary-directory ownership');
  }

  const prefix =
    `deployme-${kind}-v1.` +
    `${owner.deploymentId}.` +
    `${owner.processingToken}.` +
    `${process.pid}.`;

  return mkdtemp(path.join(os.tmpdir(), prefix));
}