export const resourceUsageSelect = {
  executionNumber: true,
  startedAt: true,
  finishedAt: true,
  lastSampleAt: true,
  cpuTimeMs: true,
  peakObservedMemoryBytes: true,
  sampleCount: true,
  collectionCompleted: true,
} as const;

interface ResourceUsageRow {
  executionNumber: number;
  startedAt: Date;
  finishedAt: Date | null;
  lastSampleAt: Date | null;
  cpuTimeMs: number | null;
  peakObservedMemoryBytes: number | null;
  sampleCount: number;
  collectionCompleted: boolean;
}

export function withDeploymentResourceSummary<
  T extends {
    processingAttempt: number;
    resourceUsage: ResourceUsageRow[];
  },
>(deployment: T) {
  const {
    processingAttempt,
    resourceUsage,
    ...publicDeployment
  } = deployment;

  const executions = [...resourceUsage].sort(
    (a, b) => a.executionNumber - b.executionNumber,
  );

  const cpuMeasurements = executions
    .map((row) => row.cpuTimeMs)
    .filter((value): value is number => value !== null);

  const memoryMeasurements = executions
    .map((row) => row.peakObservedMemoryBytes)
    .filter((value): value is number => value !== null);

  const hasSamples = executions.some((row) => row.sampleCount > 0);

  // Missing earlier executions must not be presented as complete coverage.
  const coversExecutions =
    processingAttempt > 0 &&
    executions.length === processingAttempt &&
    executions.every(
      (row, index) => row.executionNumber === index + 1,
    );

  const complete =
    hasSamples &&
    coversExecutions &&
    executions.every(
      (row) =>
        row.collectionCompleted &&
        row.finishedAt !== null &&
        row.sampleCount > 0 &&
        row.cpuTimeMs !== null &&
        row.peakObservedMemoryBytes !== null,
    );

  const status: 'unavailable' | 'partial' | 'complete' =
    !hasSamples ? 'unavailable' : complete ? 'complete' : 'partial';

  return {
    ...publicDeployment,
    resourceUsage: {
      status,
      cpuTimeMs:
        cpuMeasurements.length > 0
          ? cpuMeasurements.reduce((sum, value) => sum + value, 0)
          : null,
      peakObservedMemoryBytes:
        memoryMeasurements.length > 0
          ? memoryMeasurements.reduce(
              (maximum, value) => Math.max(maximum, value),
              0,
            )
          : null,
      expectedExecutionCount: processingAttempt,
      recordedExecutionCount: executions.length,
      sampleCount: executions.reduce(
        (sum, row) => sum + row.sampleCount,
        0,
      ),
      executions,
    },
  };
}