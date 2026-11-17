import type { PublicBuildVariables } from './public-build-variables.js';
import { env } from '../config/env.js';

export const BUILD_IMAGE =
  'node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da';
export const PNPM_BUILD_IMAGE =
  env.PNPM_BUILD_IMAGE ?? 'sha256:d06258e02f53c59ac81c702ad308d11cddc23c16b06f809ed8c631b62abcd0af';
export const PNPM_BUILD_VERSION = '12.18.0';
export const PNPM_INSTALL_COMMAND = 'pnpm install --frozen-lockfile';

export const BUILD_LIMITS = {
  timeoutMs: 10 * 60 * 1_000,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  cpus: 1,
  pids: 256,
  maxLogBytes: 5 * 1024 * 1024,
} as const;

export type BuildLogStream = 'stdout' | 'stderr';

export interface BuildRunnerInput {
  outputDirectory: string;
  deploymentId: string;
  repositoryRoot: string;
  installCommand: string;
  buildCommand: string;
  processingToken: string;
  publicBuildVariables?: PublicBuildVariables;
  onLog: (stream: BuildLogStream, text: string) => void;
}
