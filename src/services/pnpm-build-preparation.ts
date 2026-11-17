import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { validatePnpmWorkspaceConfig } from './pnpm-workspace-config.js';
import { PNPM_BUILD_VERSION } from './build-runner.js';
import type { BuildTempOwner } from './build-temp-directory.js';
import { downloadPnpmTarballs } from './pnpm-tarball-downloader.js';
import { BuildConfigurationError } from './build-configuration-error.js';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function readRegularManifest(repositoryRoot: string, filename: string): Promise<string> {
  const filePath = path.join(repositoryRoot, filename);
  const stats = await lstat(filePath);

  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new BuildConfigurationError(`pnpm installation requires a regular ${filename}.`);
  }

  if (stats.size > MAX_MANIFEST_BYTES) {
    throw new BuildConfigurationError(`${filename} exceeds the inspection size limit.`);
  }

  const contents = await readFile(filePath);

  if (contents.length > MAX_MANIFEST_BYTES) {
    throw new BuildConfigurationError(`${filename} exceeds the inspection size limit.`);
  }

  return contents.toString('utf8');
}

export async function preparePnpmBuildTarballs(repositoryRoot: string, owner: BuildTempOwner) {
  const unsupportedFiles = [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'pnpm-workspace.yaml',
    '.npmrc',
    '.pnpmfile.cjs',
    '.pnpmfile.mjs',
    'pnpmfile.cjs',
    'pnpmfile.mjs',
    'pnpm-workspace.yaml',
  ];

  for (const filename of unsupportedFiles) {
    if (await exists(path.join(repositoryRoot, filename))) {
      throw new BuildConfigurationError(
        `The initial pnpm build path does not support ${filename} in the ` +
          'selected application folder. Use a supported standalone configuration.',
      );
    }
  }
  if (await exists(path.join(repositoryRoot, 'pnpm-workspace.yaml'))) {
    const workspaceSource = await readRegularManifest(repositoryRoot, 'pnpm-workspace.yaml');

    validatePnpmWorkspaceConfig(workspaceSource);
  }

  const manifestSource = await readRegularManifest(repositoryRoot, 'package.json');

  let manifest: unknown;

  try {
    manifest = JSON.parse(manifestSource);
  } catch {
    throw new BuildConfigurationError('package.json contains invalid JSON.');
  }

  if (!isRecord(manifest)) {
    throw new BuildConfigurationError('package.json must contain an object.');
  }

  if (
    manifest.packageManager !== undefined &&
    manifest.packageManager !== `pnpm@${PNPM_BUILD_VERSION}`
  ) {
    throw new BuildConfigurationError(
      `This pnpm build image supports exactly pnpm@${PNPM_BUILD_VERSION}.`,
    );
  }

  if (
    manifest.workspaces !== undefined ||
    manifest.pnpm !== undefined ||
    manifest.devEngines !== undefined
  ) {
    throw new BuildConfigurationError(
      'Workspace, package-manager configuration, and devEngines declarations ' +
        'require additional support in the pnpm build path.',
    );
  }

  const lockfileSource = await readRegularManifest(repositoryRoot, 'pnpm-lock.yaml');

  // Validation finishes before the downloader makes network requests.
  return downloadPnpmTarballs(lockfileSource, owner);
}
