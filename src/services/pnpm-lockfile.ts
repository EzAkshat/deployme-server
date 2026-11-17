import { parseAllDocuments } from 'yaml';
import { BuildConfigurationError } from './build-configuration-error.js';
import { PNPM_BUILD_VERSION } from './build-runner.js';
import type { NpmTarball } from './npm-lockfile.js';
import { MAX_TARBALLS } from './npm-tarball-downloader.js';

const MAX_LOCKFILE_BYTES = 4 * 1024 * 1024;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

// Peer-dependency suffixes belong to snapshots, not package keys.
const PACKAGE_KEY =
  /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?)$/;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validatePnpmLockfile(source: string): NpmTarball[] {
  if (Buffer.byteLength(source, 'utf8') > MAX_LOCKFILE_BYTES) {
    throw new BuildConfigurationError('The pnpm lockfile exceeds the inspection size limit.');
  }

  let values: unknown[];

  try {
    const documents = parseAllDocuments(source, {
      schema: 'core',
      uniqueKeys: true,
    });

    if (documents.length < 1 || documents.length > 2) {
      throw new BuildConfigurationError('Unsupported document count');
    }

    values = documents.map((document) => {
      if (document.errors.length > 0 || document.warnings.length > 0) {
        throw new BuildConfigurationError('Unsupported YAML');
      }

      return document.toJS({ maxAliasCount: 0 }) as unknown;
    });
  } catch {
    throw new BuildConfigurationError(
      'The pnpm lockfile must contain one or two valid YAML documents ' +
        'without duplicate keys, aliases, or custom tags.',
    );
  }

  const tarballs = new Map<string, string>();
  let packageEntryCount = 0;

  for (const [index, value] of values.entries()) {
    const hasBootDocument = values.length === 2;
    const isBootDocument = hasBootDocument && index === 0;

    // Validate separately so one document cannot overwrite another's importer.
    const validated = validatePnpmDocument(value, isBootDocument, hasBootDocument);

    if (isRecord(value) && isRecord(value.packages)) {
      packageEntryCount += Object.keys(value.packages).length;
    }

    if (packageEntryCount > MAX_TARBALLS) {
      throw new BuildConfigurationError(
        `The pnpm lockfile exceeds the combined limit of ${MAX_TARBALLS} package entries.`,
      );
    }

    for (const tarball of validated) {
      const previous = tarballs.get(tarball.url);

      if (previous !== undefined && previous !== tarball.integrity) {
        throw new BuildConfigurationError(
          'The pnpm lockfile documents specify conflicting integrity values for a package.',
        );
      }

      tarballs.set(tarball.url, tarball.integrity);
    }
  }

  return Array.from(tarballs, ([url, integrity]) => ({
    url,
    integrity,
  }));
}

function validatePnpmDocument(
  value: unknown,
  isBootDocument: boolean,
  hasBootDocument: boolean,
): NpmTarball[] {
  if (!isRecord(value) || String(value.lockfileVersion) !== '9.0' || !isRecord(value.importers)) {
    throw new BuildConfigurationError('DeployMe currently requires pnpm lockfile version 9.0.');
  }

  const importerNames = Object.keys(value.importers);

  if (importerNames.length !== 1 || importerNames[0] !== '.' || !isRecord(value.importers['.'])) {
    throw new BuildConfigurationError(
      'Automatic pnpm builds currently require one standalone application at the lockfile root.',
    );
  }

  for (const field of ['patchedDependencies', 'catalogs', 'overrides']) {
    const setting = value[field];

    if (setting !== undefined && (!isRecord(setting) || Object.keys(setting).length > 0)) {
      throw new BuildConfigurationError(
        `Automatic pnpm builds do not yet support lockfile ${field}.`,
      );
    }
  }

  const importer = value.importers['.'];

  // Plugins and downloadable runtimes remain unsupported.
  for (const field of ['configDependencies', 'runtimeDependencies']) {
    const setting = importer[field];

    if (setting !== undefined && (!isRecord(setting) || Object.keys(setting).length > 0)) {
      throw new BuildConfigurationError(
        `The pnpm lockfile contains ${field}; additional toolchain preparation is required.`,
      );
    }
  }

  const managers = importer.packageManagerDependencies;
  let hasManagerPin = false;

  if (managers !== undefined) {
    if (!isRecord(managers)) {
      throw new BuildConfigurationError('Invalid packageManagerDependencies section.');
    }

    const names = Object.keys(managers);

    if (names.length > 0) {
      if (names.length !== 1 || names[0] !== 'pnpm') {
        throw new BuildConfigurationError('Only the pinned pnpm package manager is supported.');
      }

      const pin = managers.pnpm;

      if (
        !isRecord(pin) ||
        Object.keys(pin).some((field) => field !== 'specifier' && field !== 'version') ||
        pin.specifier !== PNPM_BUILD_VERSION ||
        pin.version !== PNPM_BUILD_VERSION
      ) {
        throw new BuildConfigurationError(
          `The lockfile must pin pnpm exactly to ${PNPM_BUILD_VERSION}, ` +
            'matching the build image.',
        );
      }

      hasManagerPin = true;
    }
  }

  if (isBootDocument) {
    if (!hasManagerPin) {
      throw new BuildConfigurationError(
        'The pnpm boot document must declare the supported pnpm version.',
      );
    }

    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = importer[field];

      if (
        dependencies !== undefined &&
        (!isRecord(dependencies) || Object.keys(dependencies).length > 0)
      ) {
        throw new BuildConfigurationError(
          'Application dependencies must be in the final lockfile document.',
        );
      }
    }
  } else if (hasBootDocument && hasManagerPin) {
    throw new BuildConfigurationError(
      'Package-manager dependencies must be in the first lockfile document.',
    );
  }

  // The downloader verifies compressed npm tarballs.
  if (value.settings !== undefined) {
    if (!isRecord(value.settings)) {
      throw new BuildConfigurationError('Invalid pnpm lockfile settings.');
    }

    if (value.settings.integrityTarget !== undefined) {
      throw new BuildConfigurationError(
        'Explicit integrityTarget settings are not supported by this tarball downloader.',
      );
    }
  }

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = importer[field];

    if (dependencies === undefined) continue;

    if (!isRecord(dependencies)) {
      throw new BuildConfigurationError(
        'The pnpm lockfile contains an invalid dependency section.',
      );
    }

    for (const dependency of Object.values(dependencies)) {
      if (
        !isRecord(dependency) ||
        typeof dependency.specifier !== 'string' ||
        typeof dependency.version !== 'string'
      ) {
        throw new BuildConfigurationError(
          'The pnpm lockfile contains an invalid dependency entry.',
        );
      }

      if (
        /^(?:workspace:|link:|file:|git|https?:|github:|catalog:)/i.test(dependency.specifier) ||
        /^(?:workspace:|link:|file:|git|https?:|github:)/i.test(dependency.version)
      ) {
        throw new BuildConfigurationError(
          'Automatic pnpm builds currently support registry dependencies only.',
        );
      }
    }
  }

  const packages = value.packages ?? {};

  if (!isRecord(packages)) {
    throw new BuildConfigurationError('The pnpm lockfile contains an invalid packages section.');
  }

  const entries = Object.entries(packages);

  if (entries.length > MAX_TARBALLS) {
    throw new BuildConfigurationError(
      `The pnpm lockfile exceeds the limit of ${MAX_TARBALLS} package entries.`,
    );
  }

  const tarballs = new Map<string, string>();

  for (const [key, entry] of entries) {
    const match = PACKAGE_KEY.exec(key);

    if (!match || !isRecord(entry) || !isRecord(entry.resolution)) {
      throw new BuildConfigurationError(
        'The pnpm lockfile contains an unsupported package identity or resolution.',
      );
    }

    const name = match[1];
    const version = match[2];

    if (!name || !version) {
      throw new BuildConfigurationError('The pnpm lockfile contains an invalid package identity.');
    }

    const resolution = entry.resolution;

    // Explicit URLs and alternate integrity targets are unsupported.
    if (
      Object.keys(resolution).some((field) => field !== 'integrity') ||
      typeof resolution.integrity !== 'string' ||
      !SHA512.test(resolution.integrity)
    ) {
      throw new BuildConfigurationError(
        'DeployMe requires pnpm packages pinned to standard public npm tarballs with SHA-512 integrity.',
      );
    }

    const basename = name.slice(name.lastIndexOf('/') + 1);
    const url = `https://registry.npmjs.org/${name}/-/` + `${basename}-${version}.tgz`;

    const existing = tarballs.get(url);

    if (existing !== undefined && existing !== resolution.integrity) {
      throw new BuildConfigurationError(
        'The pnpm lockfile specifies conflicting integrity values for a package.',
      );
    }

    tarballs.set(url, resolution.integrity);
  }

  return Array.from(tarballs, ([url, integrity]) => ({
    url,
    integrity,
  }));
}
