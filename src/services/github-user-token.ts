import { z } from 'zod';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import { encryptGitHubToken, decryptGitHubToken } from './github-token-encryption.js';

const REFRESH_BUFFER_MS = 60_000;

const refreshedTokensSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('bearer'),
  expires_in: z.number().int().positive().max(31_536_000),
  refresh_token: z.string().min(1),
  refresh_token_expires_in: z.number().int().positive().max(315_360_000),
});

export class GitHubUserTokenError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubUserTokenError';
  }
}

function requiresRefresh(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt.getTime() <= Date.now() + REFRESH_BUFFER_MS;
}

export async function getGitHubUserAccessToken(userId: number): Promise<string> {
  try {
    const connection = await prisma.gitHubConnection.findUnique({
      where: { userId },
      select: {
        accessTokenEncrypted: true,
        accessTokenExpiresAt: true,
      },
    });

    if (!connection) {
      throw new GitHubUserTokenError(
        'GITHUB_CONNECTION_REQUIRED',
        409,
        'Connect your GitHub account first.',
      );
    }

    if (!requiresRefresh(connection.accessTokenExpiresAt)) {
      return decryptGitHubToken(connection.accessTokenEncrypted, userId, 'access');
    }

    return await prisma.$transaction(
      async (tx) => {
        // Concurrent refresh requests wait here, then read the latest tokens.
        await tx.$queryRaw`
          SELECT "id"
          FROM "GitHubConnection"
          WHERE "userId" = ${userId}
          FOR UPDATE
        `;

        const current = await tx.gitHubConnection.findUnique({
          where: { userId },
        });

        if (!current) {
          throw new GitHubUserTokenError(
            'GITHUB_CONNECTION_REQUIRED',
            409,
            'Connect your GitHub account first.',
          );
        }

        if (!requiresRefresh(current.accessTokenExpiresAt)) {
          return decryptGitHubToken(current.accessTokenEncrypted, userId, 'access');
        }

        if (
          !current.refreshTokenEncrypted ||
          (current.refreshTokenExpiresAt !== null &&
            current.refreshTokenExpiresAt.getTime() <= Date.now())
        ) {
          throw new GitHubUserTokenError(
            'GITHUB_REAUTHORIZATION_REQUIRED',
            409,
            'Your GitHub connection needs authorization. Connect GitHub again.',
          );
        }

        const clientId = env.GITHUB_APP_CLIENT_ID;
        const clientSecret = env.GITHUB_APP_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
          throw new GitHubUserTokenError(
            'GITHUB_AUTHORIZATION_NOT_CONFIGURED',
            503,
            'GitHub user authorization is not configured.',
          );
        }

        const refreshToken = decryptGitHubToken(current.refreshTokenEncrypted, userId, 'refresh');

        const requestedAt = Date.now();

        const response = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });

        const body: unknown = await response.json();

        const oauthError = z
          .object({
            error: z.string(),
          })
          .safeParse(body);

        if (oauthError.success && oauthError.data.error === 'bad_refresh_token') {
          throw new GitHubUserTokenError(
            'GITHUB_REAUTHORIZATION_REQUIRED',
            409,
            'GitHub authorization is no longer valid. Connect GitHub again.',
          );
        }

        const tokens = refreshedTokensSchema.safeParse(body);

        if (!response.ok || !tokens.success) {
          throw new GitHubUserTokenError(
            'GITHUB_TOKEN_REFRESH_FAILED',
            502,
            'GitHub could not refresh your authorization. Please retry later.',
          );
        }

        await tx.gitHubConnection.update({
          where: { id: current.id },
          data: {
            accessTokenEncrypted: encryptGitHubToken(tokens.data.access_token, userId, 'access'),
            refreshTokenEncrypted: encryptGitHubToken(tokens.data.refresh_token, userId, 'refresh'),
            accessTokenExpiresAt: new Date(requestedAt + tokens.data.expires_in * 1000),
            refreshTokenExpiresAt: new Date(
              requestedAt + tokens.data.refresh_token_expires_in * 1000,
            ),
          },
        });

        return tokens.data.access_token;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 5_000,
        timeout: 30_000,
      },
    );
  } catch (error: unknown) {
    if (error instanceof GitHubUserTokenError) {
      throw error;
    }

    throw new GitHubUserTokenError(
      'GITHUB_TOKEN_REFRESH_FAILED',
      502,
      'Unable to retrieve GitHub authorization. Please retry later.',
    );
  }
}
