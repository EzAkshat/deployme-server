export const BUILD_IMAGE =
  'node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da';

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
  onLog: (stream: BuildLogStream, text: string) => void;
}
