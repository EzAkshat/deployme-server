export interface NpmTarball {
  url: string;
  integrity: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateNpmLockfile(lockfile: unknown): NpmTarball[] {
  if (
    !isRecord(lockfile) ||
    lockfile.lockfileVersion !== 3 ||
    !isRecord(lockfile.packages) ||
    !isRecord(lockfile.packages[''])
  ) {
    throw new Error('DeployMe requires an npm v3 lockfile with a root package.');
  }

  // Accept canonical public npm tarball URLs, including scoped packages.
  const tarballUrl =
    /^https:\/\/registry\.npmjs\.org\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/-\/[a-zA-Z0-9._+-]+\.tgz$/;
  const sha512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
  const tarballs = new Map<string, string>();

  for (const [location, entry] of Object.entries(lockfile.packages)) {
    if (location === '') continue;

    if (
      !location.startsWith('node_modules/') ||
      !isRecord(entry) ||
      entry.link === true ||
      typeof entry.resolved !== 'string' ||
      !tarballUrl.test(entry.resolved) ||
      typeof entry.integrity !== 'string' ||
      !sha512.test(entry.integrity)
    ) {
      throw new Error(
        'DeployMe requires dependencies pinned to public npm tarballs with SHA-512 integrity.',
      );
    }

    const existingIntegrity = tarballs.get(entry.resolved);

    if (existingIntegrity !== undefined && existingIntegrity !== entry.integrity) {
      throw new Error('The npm lockfile specifies conflicting integrity values for one tarball.');
    }

    tarballs.set(entry.resolved, entry.integrity);
  }

  return Array.from(tarballs, ([url, integrity]) => ({ url, integrity }));
}
