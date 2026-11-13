import { z } from 'zod';
import { validateNpmLockfile } from './npm-lockfile.js';
import { MAX_TARBALLS } from './npm-tarball-downloader.js';

export interface ProjectInspectionInput {
  // Immediate file names in the selected app folder.
  fileNames: string[];
  packageJson?: string;
  packageLockJson?: string;
}

export interface DetectedBuildSettings {
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  spaFallback: boolean;
}

export interface ProjectDetectionResult {
  projectType: 'static' | 'npm-vite' | 'unknown';
  requiresReview: boolean;
  reasons: string[];
  settings: DetectedBuildSettings | null;
}

const packageSchema = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  packageManager: z.string().optional(),
  workspaces: z.unknown().optional(),
});

function manualReview(
  reason: string,
  projectType: ProjectDetectionResult['projectType'] = 'unknown',
): ProjectDetectionResult {
  return {
    projectType,
    requiresReview: true,
    reasons: [reason],
    settings: null,
  };
}

export function detectProjectSettings(input: ProjectInspectionInput): ProjectDetectionResult {
  const files = new Set(input.fileNames);

  const otherBuildMarkers = [
    'requirements.txt',
    'pyproject.toml',
    'Pipfile',
    'composer.json',
    'Gemfile',
    'go.mod',
    'Cargo.toml',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'Dockerfile',
  ];

  if (otherBuildMarkers.some((filename) => files.has(filename))) {
    return manualReview(
      'This folder contains another build or runtime configuration. Select the static app folder or review its deployment settings.',
    );
  }

  if (!files.has('package.json')) {
    if (!files.has('index.html')) {
      return manualReview(
        'No package.json or index.html was found. Select the folder containing the app.',
      );
    }

    return {
      projectType: 'static',
      requiresReview: true,
      reasons: [
        'A static-site candidate was found. Confirm that this folder contains the finished public website files.',
      ],
      settings: {
        installCommand: '',
        buildCommand: '',
        outputDirectory: '.',
        spaFallback: false,
      },
    };
  }

  if (input.packageJson === undefined) {
    return manualReview('package.json could not be read.');
  }

  let packageValue: unknown;

  try {
    packageValue = JSON.parse(input.packageJson);
  } catch {
    return manualReview('package.json contains invalid JSON.');
  }

  const parsed = packageSchema.safeParse(packageValue);

  if (!parsed.success) {
    return manualReview('package.json contains unsupported field formats.');
  }

  const manifest = parsed.data;

  if (manifest.workspaces !== undefined) {
    return manualReview(
      'npm workspaces need additional build support. Select a standalone app or review the repository setup.',
    );
  }

  if (manifest.packageManager !== undefined && !manifest.packageManager.startsWith('npm@')) {
    return manualReview(
      'This project declares another package manager. Automatic installation currently supports npm.',
    );
  }

  const conflictingLockfiles = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

  if (conflictingLockfiles.some((filename) => files.has(filename))) {
    return manualReview(
      'Another package-manager lockfile is present. Confirm which package manager this project uses.',
    );
  }

  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };

  if (dependencies.vite === undefined) {
    return manualReview(
      'This package is outside the initial npm + Vite preset. Review its build settings.',
    );
  }

  const buildScript = manifest.scripts?.build?.trim();

  const supportedBuildScripts = new Set([
    'vite build',
    'tsc && vite build',
    'tsc -b && vite build',
  ]);

  if (!buildScript || !supportedBuildScripts.has(buildScript)) {
    return manualReview(
      'The build script needs review before DeployMe can select an output directory.',
      'npm-vite',
    );
  }

  if (!files.has('package-lock.json') || input.packageLockJson === undefined) {
    return manualReview('Automatic npm builds require a committed package-lock.json.', 'npm-vite');
  }

  let lockfile: unknown;

  try {
    lockfile = JSON.parse(input.packageLockJson);
  } catch {
    return manualReview('package-lock.json contains invalid JSON.', 'npm-vite');
  }

  try {
    const tarballs = validateNpmLockfile(lockfile);

    if (tarballs.length > MAX_TARBALLS) {
      return manualReview(
        `The lockfile exceeds the current limit of ${MAX_TARBALLS} dependency tarballs.`,
        'npm-vite',
      );
    }
  } catch (error: unknown) {
    return manualReview(
      error instanceof Error ? error.message : 'The lockfile is unsupported.',
      'npm-vite',
    );
  }

  const reasons: string[] = [];

  if (!files.has('index.html')) {
    reasons.push('No index.html was found in this folder. Confirm the Vite root and build entry.');
  }

  if (
    input.fileNames.some((filename) => /^vite\.config\.(?:js|ts|mjs|mts|cjs|cts)$/.test(filename))
  ) {
    reasons.push(
      'A Vite configuration file is present. Confirm that it produces a static site in dist.',
    );
  }

  if (manifest.scripts?.prebuild || manifest.scripts?.postbuild) {
    reasons.push(
      'Build lifecycle scripts are present. Confirm their effect on the published output.',
    );
  }

  if (
    dependencies['react-router-dom'] ||
    dependencies['react-router'] ||
    dependencies['vue-router']
  ) {
    reasons.push(
      'A client-side router was detected. Confirm whether SPA fallback should be enabled.',
    );
  }

  return {
    projectType: 'npm-vite',
    requiresReview: reasons.length > 0,
    reasons,
    settings: {
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      outputDirectory: 'dist',
      spaFallback: false,
    },
  };
}
