import { z } from 'zod';

const MAX_VARIABLES = 50;
const MAX_VALUE_BYTES = 4_096;
const MAX_TOTAL_BYTES = 16_384;

// Restrict names to public application configuration.
// This prevents overriding PATH, NODE_OPTIONS, npm settings,
// and other controls belonging to the build runner.
const publicVariableName = z
  .string()
  .max(128)
  .regex(
    /^(?:VITE_|NEXT_PUBLIC_|NUXT_PUBLIC_|REACT_APP_|VUE_APP_|PUBLIC_)[A-Z][A-Z0-9_]*$/,
    'Use an uppercase public variable name, such as VITE_API_BASE_URL or PUBLIC_API_BASE_URL.',
  );

const publicVariableValue = z
  .string()
  .refine((value) => !value.includes('\0'), 'Public variable values must not contain null bytes.')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_VALUE_BYTES,
    `Each public variable value must be at most ${MAX_VALUE_BYTES} bytes.`,
  );

export const publicBuildVariablesSchema = z
  .record(publicVariableName, publicVariableValue)
  .superRefine((variables, context) => {
    const entries = Object.entries(variables);

    if (entries.length > MAX_VARIABLES) {
      context.addIssue({
        code: 'custom',
        message: `Provide at most ${MAX_VARIABLES} public build variables.`,
      });
    }

    const totalBytes = entries.reduce(
      (total, [name, value]) =>
        total + Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8') + 2,
      0,
    );

    if (totalBytes > MAX_TOTAL_BYTES) {
      context.addIssue({
        code: 'custom',
        message: `Public build variables must total at most ${MAX_TOTAL_BYTES} bytes.`,
      });
    }
  });

export type PublicBuildVariables = z.infer<typeof publicBuildVariablesSchema>;

export function publicBuildVariableEnvironment(value: unknown): string[] {
  const variables = publicBuildVariablesSchema.parse(value);

  return Object.entries(variables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, contents]) => `${name}=${contents}`);
}
