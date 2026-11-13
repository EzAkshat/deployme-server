import yauzl from 'yauzl';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_PATH_LENGTH = 1_024;

type ZipEntry = yauzl.Entry;

function validateEntryPath(entryName: string): string {
  if (
    !entryName ||
    entryName.length > MAX_PATH_LENGTH ||
    entryName.includes('\0') ||
    entryName.includes('\\') ||
    path.posix.isAbsolute(entryName) ||
    /^[a-zA-Z]:/.test(entryName)
  ) {
    throw new Error('Unsafe archive entry path');
  }

  const normalized = path.posix.normalize(entryName);

  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error('Archive entry escapes extraction directory');
  }

  return normalized;
}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
      },
      (error, zipFile) => {
        if (error) {
          reject(error);
          return;
        }

        if (!zipFile) {
          reject(new Error('Could not open repository archive'));
          return;
        }

        resolve(zipFile);
      },
    );
  });
}

function readEntry(zipFile: yauzl.ZipFile, entry: ZipEntry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      if (!stream) {
        reject(new Error('Could not read archive entry'));
        return;
      }

      resolve(stream);
    });
  });
}

function isSymlink(entry: ZipEntry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}
function isUnsupportedEntryType(entry: ZipEntry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;

  // Some ZIP archives do not include Unix file-type metadata.
  if (fileType === 0) {
    return false;
  }

  return fileType !== 0o100000 && fileType !== 0o040000 && fileType !== 0o120000;
}
export async function extractRepositoryArchive(
  archive: Buffer,
  destination: string,
): Promise<void> {
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error('Repository archive exceeds the size limit');
  }

  const root = path.resolve(destination);
  await fs.mkdir(root, { recursive: false, mode: 0o700 });

  const zipFile = await openZip(archive);

  let entriesProcessed = 0;
  let extractedBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      zipFile.once('error', fail);

      zipFile.once('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });

      zipFile.on('entry', (entry) => {
        void (async () => {
          if (settled) return;

          entriesProcessed += 1;

          if (entriesProcessed > MAX_ENTRIES) {
            throw new Error('Archive contains too many entries');
          }

          const relativePath = validateEntryPath(entry.fileName);

          if (isSymlink(entry)) {
            throw new Error('Symbolic links are not allowed in archives');
          }

          if (isUnsupportedEntryType(entry)) {
            throw new Error('Archive contains an unsupported special file');
          }

          if (entry.fileName.endsWith('/')) {
            const directoryPath = path.resolve(root, relativePath);

            if (directoryPath !== root && !directoryPath.startsWith(`${root}${path.sep}`)) {
              throw new Error('Archive entry escapes extraction directory');
            }

            await fs.mkdir(directoryPath, { recursive: true });
            zipFile.readEntry();
            return;
          }

          if (entry.uncompressedSize > MAX_FILE_BYTES) {
            throw new Error('Archive contains a file exceeding the size limit');
          }

          extractedBytes += entry.uncompressedSize;

          if (extractedBytes > MAX_EXTRACTED_BYTES) {
            throw new Error('Extracted archive exceeds the size limit');
          }

          const outputPath = path.resolve(root, relativePath);

          if (!outputPath.startsWith(`${root}${path.sep}`)) {
            throw new Error('Archive entry escapes extraction directory');
          }

          await fs.mkdir(path.dirname(outputPath), {
            recursive: true,
          });

          const input = await readEntry(zipFile, entry);

          await pipeline(
            input,
            createWriteStream(outputPath, {
              flags: 'wx',
              mode: 0o600,
            }),
          );

          zipFile.readEntry();
        })().catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error('Archive extraction failed'));
        });
      });

      zipFile.readEntry();
    });
  } catch (error) {
    zipFile.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
