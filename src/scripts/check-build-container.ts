import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { docker } from '../config/docker.js';
import { BUILD_IMAGE } from '../services/build-runner.js';
import { waitForContainerExit } from '../services/container-lifecycle.js';

async function main(): Promise<void> {
  const container = await docker.createContainer({
    Image: BUILD_IMAGE,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Cmd: [
      'node',
      '-e',
      `
        const fs = require('node:fs');
        const assert = require('node:assert/strict');

        assert.notEqual(process.getuid(), 0);

        fs.writeFileSync('/workspace/check.txt', 'workspace works');

        assert.equal(
          fs.readFileSync('/workspace/check.txt', 'utf8'),
          'workspace works',
        );

        assert.throws(
          () => fs.writeFileSync('/root-filesystem-check.txt', 'blocked'),
          (error) => error.code === 'EROFS' || error.code === 'EACCES',
        );

        console.log(
          'Workspace write and filesystem restriction checks passed.',
        );
      `,
    ],
    User: 'node',
    NetworkDisabled: true,
    HostConfig: {
      Tmpfs: {
        '/workspace': 'rw,nosuid,nodev,size=64m,mode=0700,uid=1000,gid=1000',
      },
      Init: true,
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 128,
    },
  });

  console.log('Created test container:', container.id);

  try {
    await container.start();

    const exitCode = await waitForContainerExit(container, 5_000);

    const logs = await container.logs({
      follow: false,
      stdout: true,
      stderr: true,
      tail: 100,
    });

    const logStream = Readable.from([logs]);

    docker.modem.demuxStream(logStream, process.stdout, process.stderr);

    await finished(logStream);

    if (exitCode !== 0) {
      throw new Error(`Container check failed with exit code ${exitCode}`);
    }

    console.log('Restricted Node container exited successfully.');
  } finally {
    await container.remove({ force: true, v: true });
    console.log('Test container removed.');
  }
}

main().catch((error: unknown) => {
  console.error('Container check failed:', error);
  process.exitCode = 1;
});
