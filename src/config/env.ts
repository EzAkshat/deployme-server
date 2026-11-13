import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  OTP_SECRET: z.string().min(32).optional(),

  RESEND_API_KEY: z.string().min(1).optional(),

  RESEND_FROM: z.string().min(1).optional(),

  FRONTEND_ORIGIN: z.string().url().optional(),

  ADMIN_ORIGIN: z.string().url().optional(),

  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),

  GITHUB_APP_ID: z.coerce.number().int().positive().optional(),

  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),

  GITHUB_WEBHOOK_SECRET: z.string().min(32).optional(),

  GITHUB_INSTALLATION_ID: z.coerce.number().int().positive().optional(),

  R2_BUCKET_NAME: z.string().trim().min(1).optional(),

  R2_ENDPOINT: z.string().url().optional(),

  R2_ACCESS_KEY_ID: z.string().trim().min(1).optional(),

  R2_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),

  GITHUB_APP_CLIENT_ID: z.string().trim().min(1).optional(),

  GITHUB_APP_CLIENT_SECRET: z.string().trim().min(1).optional(),

  GITHUB_APP_CALLBACK_URL: z.string().url().optional(),

  GITHUB_TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/, 'Must contain exactly 64 hexadecimal characters')
    .optional(),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('Invalid environment configuration:');
  console.error(result.error.flatten().fieldErrors);

  throw new Error('Environment configuration validation failed');
}

if (result.data.NODE_ENV !== 'test' && !result.data.OTP_SECRET) {
  throw new Error('OTP_SECRET must be configured outside test mode');
}

if (Boolean(result.data.RESEND_API_KEY) !== Boolean(result.data.RESEND_FROM)) {
  throw new Error('RESEND_API_KEY and RESEND_FROM must be configured together');
}

if (result.data.NODE_ENV === 'production' && !result.data.FRONTEND_ORIGIN) {
  throw new Error('FRONTEND_ORIGIN must be configured in production');
}

if (result.data.NODE_ENV === 'production' && !result.data.ADMIN_ORIGIN) {
  throw new Error('ADMIN_ORIGIN must be configured in production');
}

if (Boolean(result.data.GITHUB_APP_ID) !== Boolean(result.data.GITHUB_APP_PRIVATE_KEY)) {
  throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured together');
}
const githubUserAuthorizationSettings = [
  result.data.GITHUB_APP_CLIENT_ID,
  result.data.GITHUB_APP_CLIENT_SECRET,
  result.data.GITHUB_APP_CALLBACK_URL,
];

const hasAnyGitHubUserAuthorizationSetting = githubUserAuthorizationSettings.some(
  (value) => value !== undefined,
);

const hasAllGitHubUserAuthorizationSettings = githubUserAuthorizationSettings.every(
  (value) => value !== undefined,
);

if (hasAnyGitHubUserAuthorizationSetting && !hasAllGitHubUserAuthorizationSettings) {
  throw new Error(
    'GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, and GITHUB_APP_CALLBACK_URL must be configured together',
  );
}
export const env = result.data;
