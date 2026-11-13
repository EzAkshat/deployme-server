import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { downloadBuildArtifacts } from '../services/container-artifacts.js';
import { docker } from '../config/docker.js';
import { runIsolatedBuild } from '../services/isolated-build.js';
import { runContainerCommand } from '../services/container-command.js';
import { validateArtifactArchive } from '../services/artifact-validation.js';
import { randomUUID } from 'node:crypto';

async function main(): Promise<void> {
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'deployme-runner-check-'));

  let containerId: string | undefined;
  const artifactArchive = path.join(sourceDirectory, 'build-output.tar');

  const onLog = (stream: 'stdout' | 'stderr', text: string): void => {
    const destination = stream === 'stderr' ? process.stderr : process.stdout;

    destination.write(text);
  };

  try {
    await mkdir(path.join(sourceDirectory, 'nested'));

    await writeFile(path.join(sourceDirectory, 'nested', 'hello.txt'), 'Hello from DeployMe');

    await writeFile(
      path.join(sourceDirectory, 'build.cjs'),
      `
        const fs = require('node:fs');

        const message = fs.readFileSync('nested/hello.txt', 'utf8');

        fs.mkdirSync('dist', { recursive: true });
        fs.writeFileSync(
          'dist/index.html',
          '<!doctype html><html><body><h1>' +
            message +
            '</h1></body></html>',
        );

        console.log('Build fixture: dist/index.html generated.');
      `,
    );

    await writeFile(
      path.join(sourceDirectory, 'verify.cjs'),
      `
        const fs = require('node:fs');
        const assert = require('node:assert/strict');

        assert.equal(process.getuid(), 1000);

        const output = 'dist/index.html';
        const stats = fs.lstatSync(output);

        assert.ok(stats.isFile());
        assert.equal(stats.uid, 1000);
        assert.equal(stats.gid, 1000);

        assert.equal(
          fs.readFileSync(output, 'utf8'),
          '<!doctype html><html><body><h1>' +
            'Hello from DeployMe' +
            '</h1></body></html>',
        );

        console.log('Generated HTML verified inside output callback.');
      `,
    );

    await runIsolatedBuild(
      {
        deploymentId: 'local-runner-check',
        processingToken: randomUUID(),
        repositoryRoot: sourceDirectory,
        installCommand: '',
        buildCommand: 'node build.cjs',
        outputDirectory: 'dist',
        onLog,
      },
      async (container, outputPath) => {
        assert.equal(outputPath, '/workspace/dist');
        containerId = container.id;

        await runContainerCommand(container, 'node verify.cjs', 5_000, {
          maxLogBytes: 64 * 1024,
          onLog,
        });
        const archiveBytes = await downloadBuildArtifacts(container, outputPath, artifactArchive);
        const archiveStats = await stat(artifactArchive);
        assert.ok(archiveStats.size > 0);

        console.log('Artifact archive downloaded:', archiveBytes, 'bytes');
      },
    );

    assert.ok(containerId, 'Output callback did not run');

    await assert.rejects(
      () => docker.getContainer(containerId!).inspect(),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        error.statusCode === 404,
      'Expected the build container to have been removed',
    );
    const files = await validateArtifactArchive(artifactArchive);

    assert.deepEqual(
      files.map((file) => file.path),
      ['index.html'],
    );

    assert.ok(files[0].size > 0);
    assert.match(files[0].sha256, /^[a-f0-9]{64}$/);

    console.log('Host artifact validation passed after container cleanup.');
    console.table(files);

    console.log('Build runner and container cleanup verified.');
  } finally {
    await rm(sourceDirectory, { recursive: true, force: true });
    console.log('Temporary source directory removed.');
  }
}

main().catch((error: unknown) => {
  console.error('Build runner check failed:', error);
  process.exitCode = 1;
});
