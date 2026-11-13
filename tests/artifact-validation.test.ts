import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import tar from 'tar-stream';

import { validateArtifactArchive } from '../src/services/artifact-validation.js';

interface TestEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  body?: string;
  linkname?: string;
}

const cases: {
  name: string;
  entries: TestEntry[];
  expected: RegExp;
}[] = [
  {
    name: 'rejects parent-directory traversal',
    entries: [{ name: '../outside.html', type: 'file', body: 'blocked' }],
    expected: /parent-directory traversal/,
  },
  {
    name: 'rejects symbolic links',
    entries: [
      {
        name: 'linked.html',
        type: 'symlink',
        linkname: '/etc/passwd',
      },
    ],
    expected: /link or special file/,
  },
  {
    name: 'rejects duplicate normalized paths',
    entries: [
      { name: './index.html', type: 'file', body: 'first' },
      { name: 'index.html', type: 'file', body: 'second' },
    ],
    expected: /duplicate paths/,
  },
  {
    name: 'rejects conflicting file and directory paths',
    entries: [
      { name: 'assets', type: 'file', body: 'file' },
      { name: 'assets/app.js', type: 'file', body: 'code' },
    ],
    expected: /conflicting file and directory paths/,
  },
  {
    name: 'rejects archives containing no files',
    entries: [{ name: './', type: 'directory' }],
    expected: /contains no files/,
  },
];

for (const scenario of cases) {
  test(`artifact validation ${scenario.name}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'deployme-artifact-test-'));

    t.after(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    const archivePath = path.join(directory, 'fixture.tar');
    const pack = tar.pack();

    const writing = pipeline(
      pack,
      createWriteStream(archivePath, {
        flags: 'wx',
        mode: 0o600,
      }),
    );

    for (const entry of scenario.entries) {
      const body = Buffer.from(entry.body ?? '');

      pack.entry(
        {
          name: entry.name,
          type: entry.type,
          size: body.length,
          ...(entry.linkname === undefined ? {} : { linkname: entry.linkname }),
        },
        body,
      );
    }

    pack.finalize();
    await writing;

    await assert.rejects(() => validateArtifactArchive(archivePath), scenario.expected);
  });
}
