import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { prisma } from '../config/database.js';
import { PNPM_INSTALL_COMMAND } from '../services/build-runner.js';
import { buildProjectArtifacts } from '../services/project-build.js';

const packageMetadataSchema = z.object({
  name: z.literal('is-number'),
  version: z.literal('7.0.0'),
  dist: z.object({
    tarball: z.literal('https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz'),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
  }),
});

async function main(): Promise<void> {
  // Only the host fetches registry metadata and verified tarballs.
  // Installation and the build run inside the network-disabled container.
  const response = await fetch('https://registry.npmjs.org/is-number/7.0.0', {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Package metadata request failed: ${response.status}`);
  }

  const metadata = packageMetadataSchema.parse(await response.json());
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'deployme-pnpm-check-'));

  try {
    const repositoryRoot = path.join(temporaryDirectory, 'source');
    await mkdir(repositoryRoot);

    await writeFile(
      path.join(repositoryRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'deployme-pnpm-check',
          version: '1.0.0',
          private: true,
          scripts: {
            build: 'node build.cjs',
          },
          dependencies: {
            'is-number': '7.0.0',
          },
        },
        null,
        2,
      ),
    );

    // JSON is valid YAML. This keeps the small fixture unambiguous.
    await writeFile(
      path.join(repositoryRoot, 'pnpm-lock.yaml'),
      JSON.stringify(
        {
          lockfileVersion: '9.0',
          settings: {
            autoInstallPeers: true,
            excludeLinksFromLockfile: false,
          },
          importers: {
            '.': {
              dependencies: {
                'is-number': {
                  specifier: '7.0.0',
                  version: '7.0.0',
                },
              },
            },
          },
          packages: {
            'is-number@7.0.0': {
              resolution: {
                integrity: metadata.dist.integrity,
              },
              engines: {
                node: '>=0.12.0',
              },
            },
          },
          snapshots: {
            'is-number@7.0.0': {},
          },
        },
        null,
        2,
      ),
    );

    await writeFile(
      path.join(repositoryRoot, 'build.cjs'),
      [
        'const assert = require("node:assert/strict");',
        'const fs = require("node:fs");',
        'const isNumber = require("is-number");',
        'assert.equal(isNumber("42"), true);',
        'assert.equal(isNumber("coffee"), false);',
        'assert.equal(process.env.PUBLIC_BUILD_CHECK, "pnpm-offline-ok");',
        'fs.mkdirSync("dist", { recursive: true });',
        'fs.writeFileSync("dist/index.html",',
        '  "<!doctype html><html><head><title>pnpm check</title></head>" +',
        '  "<body>Offline pnpm dependency installation worked.</body></html>");',
        'console.log("Dependency and public build variable checks passed.");',
      ].join('\n'),
    );

    const result = await buildProjectArtifacts(
      {
        deploymentId: `pnpm-check-${randomUUID()}`,
        processingToken: randomUUID(),
        repositoryRoot,
        installCommand: PNPM_INSTALL_COMMAND,
        buildCommand: 'pnpm run build',
        outputDirectory: 'dist',
        publicBuildVariables: {
          PUBLIC_BUILD_CHECK: 'pnpm-offline-ok',
        },
        onLog: (stream, text) => {
          if (stream === 'stderr') process.stderr.write(text);
          else process.stdout.write(text);
        },
      },
      path.join(temporaryDirectory, 'artifacts.tar'),
    );

    assert.ok(
      result.files.some((file) => file.path === 'index.html'),
      'The validated artifacts must include index.html.',
    );

    console.log(
      '\nPASS: pnpm installed the dependency offline, received the public ' +
        'build variable, and produced validated website artifacts.',
    );
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      'pnpm build check failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
