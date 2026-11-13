import { rm } from 'node:fs/promises';

import type { BuildRunnerInput } from './build-runner.js';
import { runIsolatedBuild } from './isolated-build.js';
import { downloadBuildArtifacts } from './container-artifacts.js';
import { validateArtifactArchive, type ArtifactFile } from './artifact-validation.js';

export interface ProjectBuildResult {
  archivePath: string;
  archiveBytes: number;
  files: ArtifactFile[];
}

// archivePath must be a new file in the worker's private workspace.
// The caller owns cleanup after a successful return.
export async function buildProjectArtifacts(
  input: BuildRunnerInput,
  archivePath: string,
): Promise<ProjectBuildResult> {
  let archiveDownloaded = false;
  let archiveBytes = 0;

  try {
    await runIsolatedBuild(input, async (container, outputPath) => {
      archiveBytes = await downloadBuildArtifacts(container, outputPath, archivePath);

      archiveDownloaded = true;
    });

    // Container cleanup has completed before host validation begins.
    const files = await validateArtifactArchive(archivePath);

    return {
      archivePath,
      archiveBytes,
      files,
    };
  } catch (error) {
    if (archiveDownloaded) {
      await rm(archivePath, { force: true });
    }

    throw error;
  }
}
