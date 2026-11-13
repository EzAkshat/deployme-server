import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createBuildTempDirectory, type BuildTempOwner } from './build-temp-directory.js';
import { validateNpmLockfile } from './npm-lockfile.js';

export const MAX_TARBALLS = 512;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 5 * 60_000;

export interface VerifiedNpmTarball {
  url: string;
  integrity: string;
  filePath: string;
}

// On success, the caller owns the directory and must remove it after use.
export async function downloadNpmTarballs(lockfile: unknown, owner?: BuildTempOwner) {
  const tarballs = validateNpmLockfile(lockfile);

  if (tarballs.length > MAX_TARBALLS) {
    throw new Error('The npm lockfile exceeds the tarball count limit.');
  }

  const directory = owner
    ? await createBuildTempDirectory('npm', owner)
    : await mkdtemp(path.join(os.tmpdir(), 'deployme-npm-'));
  const deadline = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const files: VerifiedNpmTarball[] = [];
  let totalBytes = 0;

  try {
    for (const tarball of tarballs) {
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);

      const response = await fetch(tarball.url, {
        redirect: 'error',
        signal,
      });

      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new Error(`npm tarball download failed with HTTP ${response.status}.`);
      }

      const filePath = path.join(directory, `${files.length}.tgz`);
      const hash = createHash('sha512');
      let fileBytes = 0;

      await pipeline(
        response.body,
        async function* (chunks) {
          for await (const chunk of chunks) {
            fileBytes += chunk.length;
            totalBytes += chunk.length;

            if (fileBytes > MAX_TARBALL_BYTES || totalBytes > MAX_TOTAL_BYTES) {
              throw new Error('npm tarball download exceeded the size limit.');
            }

            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(filePath, { flags: 'wx', mode: 0o600 }),
        { signal },
      );

      if (`sha512-${hash.digest('base64')}` !== tarball.integrity) {
        throw new Error('Downloaded npm tarball failed its integrity check.');
      }

      files.push({ ...tarball, filePath });
    }

    return { directory, files, totalBytes };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
