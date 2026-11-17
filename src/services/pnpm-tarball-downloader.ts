import type { BuildTempOwner } from './build-temp-directory.js';
import { downloadNpmTarballs } from './npm-tarball-downloader.js';
import { validatePnpmLockfile } from './pnpm-lockfile.js';

export async function downloadPnpmTarballs(lockfileSource: string, owner?: BuildTempOwner) {
  const tarballs = validatePnpmLockfile(lockfileSource);

  // Reuse the existing verified downloader and its managed temp directories.
  // This object is an internal download manifest, not a project lockfile.
  const downloadManifest = {
    lockfileVersion: 3,
    packages: {
      '': {},
      ...Object.fromEntries(
        tarballs.map((tarball, index) => [
          `node_modules/deployme-download-${index}`,
          {
            resolved: tarball.url,
            integrity: tarball.integrity,
          },
        ]),
      ),
    },
  };

  return downloadNpmTarballs(downloadManifest, owner);
}
