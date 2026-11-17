import { z } from 'zod';
import { validatePnpmLockfile } from './pnpm-lockfile.js';
import { PNPM_BUILD_VERSION, PNPM_INSTALL_COMMAND } from './build-runner.js';
import { validateNpmLockfile } from './npm-lockfile.js';
import { MAX_TARBALLS } from './npm-tarball-downloader.js';
import { validatePnpmWorkspaceConfig } from './pnpm-workspace-config.js';

export interface ProjectInspectionInput {
  fileNames: string[];
  packageJson?: string;
  packageLockJson?: string;
  pnpmWorkspaceYaml?: string;
  pnpmLockYaml?: string;
}

export interface DetectedBuildSettings {
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  spaFallback: boolean;
}

type FrameworkName = 'vite' | 'astro' | 'next' | 'nuxt' | 'sveltekit' | 'angular' | 'custom';

export type DetectedProjectType =
  'static' | `npm-${FrameworkName}` | `pnpm-${FrameworkName}` | 'unknown';

export interface ProjectDetectionResult {
  projectType: DetectedProjectType;
  requiresReview: boolean;
  reasons: string[];
  settings: DetectedBuildSettings | null;
}

interface FrameworkPreset {
  projectType: DetectedProjectType;
  name: string;
  dependencies: readonly string[];
  scripts: readonly string[];
  outputDirectory: string | null;
  reason: string;
}

// Framework-specific tooling takes precedence over its underlying bundler.
const FRAMEWORK_PRESETS: readonly FrameworkPreset[] = [
  {
    projectType: 'npm-next',
    name: 'Next.js',
    dependencies: ['next'],
    scripts: ['build'],
    outputDirectory: 'out',
    reason:
      'Configure Next.js for static export and confirm that out is the public ' +
      'output directory. Request-time server rendering, server actions, and ' +
      'runtime API endpoints must be handled by an external backend.',
  },
  {
    projectType: 'npm-nuxt',
    name: 'Nuxt',
    dependencies: ['nuxt'],
    scripts: ['generate'],
    outputDirectory: null,
    reason:
      'Use a static-generation script. Confirm its output directory: modern ' +
      'Nuxt commonly uses .output/public, while older versions may use dist. ' +
      'Server endpoints must be hosted separately.',
  },
  {
    projectType: 'npm-sveltekit',
    name: 'SvelteKit',
    dependencies: ['@sveltejs/kit'],
    scripts: ['build'],
    outputDirectory: 'build',
    reason:
      'Configure @sveltejs/adapter-static and confirm its public output ' +
      'directory. Any SPA fallback filename must match the hosting setup. ' +
      'Server-dependent routes cannot run on static hosting.',
  },
  {
    projectType: 'npm-astro',
    name: 'Astro',
    dependencies: ['astro'],
    scripts: ['build'],
    outputDirectory: 'dist',
    reason:
      'Confirm that the Astro build produces a fully static website in the ' +
      'selected output directory. On-demand rendering requires an external runtime.',
  },
  {
    projectType: 'npm-angular',
    name: 'Angular',
    dependencies: ['@angular/build', '@angular-devkit/build-angular', '@angular/cli'],
    scripts: ['build'],
    outputDirectory: null,
    reason:
      'Read angular.json to select the application and its public browser ' +
      'output directory. Do not publish a server bundle or the entire parent ' +
      'dist directory. Confirm that the application can run without an Angular server.',
  },
  {
    projectType: 'npm-custom',
    name: 'React Router framework mode',
    dependencies: ['@react-router/dev'],
    scripts: ['build'],
    outputDirectory: null,
    reason:
      'Confirm a static-compatible deployment mode and its complete public ' +
      'output directory. Framework server output cannot run on this hosting path.',
  },
  {
    projectType: 'npm-custom',
    name: 'Remix',
    dependencies: ['@remix-run/dev'],
    scripts: ['build'],
    outputDirectory: null,
    reason:
      'Confirm a static-compatible application configuration and its public ' +
      'output directory. A conventional server build needs separately hosted runtime services.',
  },
];

function isSafeOutputDirectory(value: string): boolean {
  if (value === '.') return true;

  if (
    value.length === 0 ||
    value.length > 255 ||
    value !== value.trim() ||
    value.startsWith('/') ||
    /[\\:\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }

  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

// Optional repository-owned configuration.
// This is public deployment metadata, not a place for secrets.
const deploymeSchema = z
  .object({
    version: z.literal(1),
    outputDirectory: z.string().refine(isSafeOutputDirectory),
    buildScript: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/)
      .default('build'),
    spaFallback: z.boolean().default(false),
  })
  .strict();

const packageSchema = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  packageManager: z.string().optional(),
  workspaces: z.unknown().optional(),
  pnpm: z.unknown().optional(),
  devEngines: z.unknown().optional(),
  deployme: z.unknown().optional(),
});

function manualReview(
  reason: string,
  projectType: DetectedProjectType = 'unknown',
): ProjectDetectionResult {
  return {
    projectType,
    requiresReview: true,
    reasons: [reason],
    settings: null,
  };
}

function validateInstallation(
  input: ProjectInspectionInput,
  files: Set<string>,
  packageManager: 'npm' | 'pnpm',
): string | null {
  try {
    if (packageManager === 'pnpm') {
      if (!files.has('pnpm-lock.yaml') || input.pnpmLockYaml === undefined) {
        return 'Automatic pnpm installation requires a readable, committed pnpm-lock.yaml.';
      }

      const tarballs = validatePnpmLockfile(input.pnpmLockYaml);

      if (tarballs.length > MAX_TARBALLS) {
        return `The lockfile exceeds the current limit of ${MAX_TARBALLS} dependency tarballs.`;
      }

      return null;
    }

    if (!files.has('package-lock.json') || input.packageLockJson === undefined) {
      return 'Automatic npm installation requires a committed package-lock.json.';
    }

    let lockfile: unknown;

    try {
      lockfile = JSON.parse(input.packageLockJson);
    } catch {
      return 'package-lock.json contains invalid JSON.';
    }

    const tarballs = validateNpmLockfile(lockfile);

    if (tarballs.length > MAX_TARBALLS) {
      return `The lockfile exceeds the current limit of ${MAX_TARBALLS} dependency tarballs.`;
    }

    return null;
  } catch (error: unknown) {
    return error instanceof Error
      ? error.message
      : `The ${packageManager} lockfile is unsupported.`;
  }
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

  const hasOtherBuildMarkers = otherBuildMarkers.some((name) => files.has(name));

  if (!files.has('package.json')) {
    if (hasOtherBuildMarkers) {
      return manualReview(
        'Another build or runtime configuration was found. Select the frontend ' +
          'folder or provide already-built public website files.',
      );
    }

    if (!files.has('index.html')) {
      return manualReview(
        'No package.json or index.html was found. Select the application folder.',
      );
    }

    return {
      projectType: 'static',
      requiresReview: true,
      reasons: ['Confirm that this folder contains only the finished public website files.'],
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
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };

  const matches = FRAMEWORK_PRESETS.filter((preset) =>
    preset.dependencies.some((dependency) => dependencies[dependency] !== undefined),
  );

  if (matches.length > 1) {
    return manualReview(
      `Multiple framework toolchains were found: ${matches
        .map((preset) => preset.name)
        .join(', ')}. Select the application folder and review its build settings.`,
    );
  }

  const preset = matches[0];

  // Presets describe the framework; the selected package manager determines
  // installation and the command used to invoke its build script.
  const frameworkType: DetectedProjectType =
    preset?.projectType ?? (dependencies.vite !== undefined ? 'npm-vite' : 'npm-custom');

  const packageManager: 'npm' | 'pnpm' =
    files.has('pnpm-lock.yaml') || manifest.packageManager?.startsWith('pnpm@') ? 'pnpm' : 'npm';

  const projectType: DetectedProjectType =
    packageManager === 'pnpm'
      ? (frameworkType.replace(/^npm-/, 'pnpm-') as DetectedProjectType)
      : frameworkType;

  if (manifest.workspaces !== undefined) {
    return manualReview(
      'Workspace dependency installation is not implemented yet. A nested ' +
        'application may depend on the repository root lockfile and other packages.',
      projectType,
    );
  }

  if (packageManager === 'pnpm') {
    if (
      manifest.packageManager !== undefined &&
      manifest.packageManager !== `pnpm@${PNPM_BUILD_VERSION}`
    ) {
      return manualReview(
        `This pnpm build image supports exactly pnpm@${PNPM_BUILD_VERSION}.`,
        projectType,
      );
    }

    if (manifest.pnpm !== undefined || manifest.devEngines !== undefined) {
      return manualReview(
        'Workspace, package-manager configuration, and devEngines declarations ' +
          'require additional support in the pnpm build path.',
        projectType,
      );
    }

    // Keep these restrictions aligned with pnpm-build-preparation.ts.
    const unsupportedFiles = [
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
      'bun.lock',
      'bun.lockb',
      '.npmrc',
      '.pnpmfile.cjs',
      '.pnpmfile.mjs',
      'pnpmfile.cjs',
      'pnpmfile.mjs',
    ];

    const unsupportedFile = unsupportedFiles.find((name) => files.has(name));

    if (unsupportedFile) {
      return manualReview(
        `The initial pnpm build path does not support ${unsupportedFile} in the ` +
          'selected application folder. Use a supported standalone configuration.',
        projectType,
      );
    }
    if (files.has('pnpm-workspace.yaml')) {
      if (input.pnpmWorkspaceYaml === undefined) {
        return manualReview('pnpm-workspace.yaml could not be read.', projectType);
      }

      try {
        validatePnpmWorkspaceConfig(input.pnpmWorkspaceYaml);
      } catch (error: unknown) {
        return manualReview(
          error instanceof Error ? error.message : 'Unsupported pnpm workspace configuration.',
          projectType,
        );
      }
    }
  } else {
    if (manifest.packageManager !== undefined && !manifest.packageManager.startsWith('npm@')) {
      return manualReview(
        'Automatic installation supports npm and the supported standalone pnpm configuration.',
        projectType,
      );
    }

    if (
      ['yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'].some((filename) =>
        files.has(filename),
      )
    ) {
      return manualReview(
        'An unsupported or competing lockfile was found. Confirm the package manager.',
        projectType,
      );
    }
  }
  let explicit: z.infer<typeof deploymeSchema> | undefined;

  if (manifest.deployme !== undefined) {
    const result = deploymeSchema.safeParse(manifest.deployme);

    if (!result.success) {
      return manualReview(
        'Invalid package.json deployme configuration. Provide version: 1, a ' +
          'relative outputDirectory, an optional buildScript name, and an optional spaFallback boolean.',
        projectType,
      );
    }

    explicit = result.data;
  }

  const installationError = validateInstallation(input, files, packageManager);

  if (installationError) {
    return manualReview(installationError, projectType);
  }

  const scripts = manifest.scripts ?? {};
  const preferredScripts = preset?.scripts ?? ['build'];

  const buildScript =
    explicit?.buildScript ??
    preferredScripts.find((name) => (scripts[name]?.trim().length ?? 0) > 0);

  if (!buildScript || !scripts[buildScript]?.trim()) {
    return manualReview(
      `No usable ${explicit?.buildScript ?? preferredScripts.join(' or ')} script ` +
        'was found. Add the appropriate static build script to package.json.',
      projectType,
    );
  }

  const outputDirectory =
    explicit?.outputDirectory ??
    preset?.outputDirectory ??
    (frameworkType === 'npm-vite' ? 'dist' : undefined);

  if (!outputDirectory) {
    return manualReview(
      `${preset?.name ?? 'Custom frontend'} detected. Set deployme.outputDirectory ` +
        'in package.json to the finished public website directory, or provide ' +
        'and confirm it in the import settings.',
      projectType,
    );
  }

  const reasons: string[] = [];

  if (preset) reasons.push(preset.reason);

  if (explicit) {
    reasons.push(
      'Repository-defined deployment settings were found. Confirm the public ' +
        'output directory and that the application uses an externally hosted backend when needed.',
    );
  }

  if (hasOtherBuildMarkers) {
    reasons.push(
      'Other build or runtime files are present. Confirm that only the frontend ' +
        'is built and published from this folder.',
    );
  }

  if (frameworkType === 'npm-custom' && !preset) {
    reasons.push(
      'A custom frontend build was selected. Confirm that it produces a complete ' +
        'browser application without requiring a hosted application server.',
    );
  }

  if (frameworkType === 'npm-vite') {
    const conventionalBuilds = new Set(['vite build', 'tsc && vite build', 'tsc -b && vite build']);

    if (!conventionalBuilds.has(scripts[buildScript]!.trim())) {
      reasons.push('The Vite build script is customized. Confirm its output directory.');
    }

    if (!files.has('index.html')) {
      reasons.push(
        'No index.html was found in this folder. Confirm the Vite root and entry point.',
      );
    }

    if (
      input.fileNames.some((filename) => /^vite\.config\.(?:js|ts|mjs|mts|cjs|cts)$/.test(filename))
    ) {
      reasons.push('A Vite configuration file is present. Confirm the public output directory.');
    }

    if (
      dependencies['react-router-dom'] ||
      dependencies['react-router'] ||
      dependencies['vue-router']
    ) {
      reasons.push('A client-side router was detected. Confirm whether SPA fallback is required.');
    }
  }

  if (scripts[`pre${buildScript}`] || scripts[`post${buildScript}`]) {
    reasons.push('Build lifecycle scripts are present. Confirm their effect on published files.');
  }

  return {
    projectType,
    requiresReview: reasons.length > 0,
    reasons,
    settings: {
      installCommand: packageManager === 'pnpm' ? PNPM_INSTALL_COMMAND : 'npm ci',
      buildCommand: `${packageManager} run ${buildScript}`,
      outputDirectory,
      spaFallback: explicit?.spaFallback ?? false,
    },
  };
}
