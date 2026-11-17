import { parseDocument } from 'yaml';
import { BuildConfigurationError } from './build-configuration-error.js';

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RULES = 512;
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validatePnpmWorkspaceConfig(source: string): void {
  if (Buffer.byteLength(source, 'utf8') > MAX_CONFIG_BYTES) {
    throw new BuildConfigurationError('pnpm-workspace.yaml exceeds the 64 KiB limit.');
  }

  let value: unknown;

  try {
    const document = parseDocument(source, {
      schema: 'core',
      uniqueKeys: true,
    });

    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new BuildConfigurationError('Unsupported YAML');
    }

    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new BuildConfigurationError(
      'pnpm-workspace.yaml must contain one valid YAML document ' +
        'without duplicate keys, aliases, or custom tags.',
    );
  }

  if (!isRecord(value)) {
    throw new BuildConfigurationError('pnpm-workspace.yaml must contain a configuration object.');
  }

  if (Object.keys(value).some((key) => key !== 'allowBuilds')) {
    throw new BuildConfigurationError(
      'Only allowBuilds is currently supported in pnpm-workspace.yaml. ' +
        'Workspace packages and other pnpm settings require additional support.',
    );
  }

  if (value.allowBuilds === undefined) return;

  if (!isRecord(value.allowBuilds)) {
    throw new BuildConfigurationError('allowBuilds must map exact package names to true or false.');
  }

  const entries = Object.entries(value.allowBuilds);

  if (entries.length > MAX_RULES) {
    throw new BuildConfigurationError(`Provide at most ${MAX_RULES} allowBuilds rules.`);
  }

  for (const [name, allowed] of entries) {
    if (name.length > 214 || !PACKAGE_NAME.test(name) || typeof allowed !== 'boolean') {
      throw new BuildConfigurationError(
        'Supported allowBuilds rules must use exact package names ' +
          'with boolean values: true to allow installation scripts, ' +
          'or false to block them.',
      );
    }
  }
}
