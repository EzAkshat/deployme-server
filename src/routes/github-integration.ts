import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requireTrustedOrigin } from '../middleware/require-origin.js';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { encryptGitHubToken } from '../services/github-token-encryption.js';
import { getGitHubUserAccessToken, GitHubUserTokenError } from '../services/github-user-token.js';
import {
  inspectGitHubProject,
  GitHubInspectionError,
} from '../services/github-project-inspection.js';
import { ProjectServiceError } from '../services/projects.js';
export const githubIntegrationRouter = Router();

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

githubIntegrationRouter.post('/connect', requireTrustedOrigin, requireAuth, async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const clientId = env.GITHUB_APP_CLIENT_ID;
  const callbackUrl = env.GITHUB_APP_CALLBACK_URL;

  if (!clientId || !callbackUrl || !env.GITHUB_APP_CLIENT_SECRET) {
    res.status(503).json({
      error: { message: 'GitHub user authorization is not configured.' },
    });
    return;
  }

  const sessionId = res.locals.authenticatedSessionId;

  if (typeof sessionId !== 'string') {
    res.status(401).json({
      error: { message: 'Authentication required.' },
    });
    return;
  }

  try {
    const state = randomBytes(32).toString('base64url');
    const stateHash = createHash('sha256').update(state).digest('hex');
    const now = new Date();

    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { expiresAt: true },
    });

    if (!session) {
      res.status(401).json({
        error: { message: 'Authentication required.' },
      });
      return;
    }

    const expiresAt = new Date(
      Math.min(now.getTime() + AUTHORIZATION_TTL_MS, session.expiresAt.getTime()),
    );

    await prisma.gitHubAuthorizationState.create({
      data: {
        stateHash,
        sessionId,
        expiresAt,
      },
    });

    const authorizationUrl = new URL('https://github.com/login/oauth/authorize');

    authorizationUrl.searchParams.set('client_id', clientId);
    authorizationUrl.searchParams.set('redirect_uri', callbackUrl);
    authorizationUrl.searchParams.set('state', state);

    res.status(200).json({
      authorizationUrl: authorizationUrl.toString(),
      expiresAt,
    });
  } catch {
    res.status(500).json({
      error: { message: 'Unable to start GitHub authorization.' },
    });
  }
});
const githubCallbackSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(512).optional(),
  error: z.string().min(1).max(200).optional(),
});

const githubTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('bearer'),
  expires_in: z.number().int().positive().max(31_536_000).optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().int().positive().max(315_360_000).optional(),
});

const githubUserResponseSchema = z.object({
  id: z.number().int().positive().safe(),
  login: z.string().min(1).max(255),
});

class GitHubCallbackError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubCallbackError';
  }
}

githubIntegrationRouter.get('/callback', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const query = githubCallbackSchema.safeParse(req.query);

  if (!query.success || (!query.data.code && !query.data.error)) {
    res.status(400).json({
      error: { message: 'Invalid GitHub authorization callback.' },
    });
    return;
  }

  const sessionId = res.locals.authenticatedSessionId;
  const userId = res.locals.authenticatedUser.id;

  if (typeof sessionId !== 'string') {
    res.status(401).json({
      error: { message: 'Authentication required.' },
    });
    return;
  }

  const clientId = env.GITHUB_APP_CLIENT_ID;
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET;
  const callbackUrl = env.GITHUB_APP_CALLBACK_URL;

  if (!clientId || !clientSecret || !callbackUrl || !env.GITHUB_TOKEN_ENCRYPTION_KEY) {
    res.status(503).json({
      error: { message: 'GitHub user authorization is not configured.' },
    });
    return;
  }

  try {
    const now = new Date();
    const stateHash = createHash('sha256').update(query.data.state).digest('hex');

    const consumed = await prisma.gitHubAuthorizationState.updateMany({
      where: {
        stateHash,
        sessionId,
        consumedAt: null,
        expiresAt: { gt: now },
        session: {
          userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
      },
      data: { consumedAt: now },
    });

    if (consumed.count !== 1) {
      throw new GitHubCallbackError(
        400,
        'GitHub authorization expired, was already used, or belongs to another session. Start Connect GitHub again.',
      );
    }

    if (query.data.error) {
      throw new GitHubCallbackError(
        400,
        'GitHub authorization was not completed. Start Connect GitHub again.',
      );
    }

    const code = query.data.code;

    if (!code) {
      throw new GitHubCallbackError(400, 'GitHub authorization code is missing.');
    }

    // Use the request start time so network delays cannot extend token expiry.
    const tokenRequestedAt = Date.now();

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });

    if (!tokenResponse.ok) {
      throw new GitHubCallbackError(
        502,
        'GitHub token exchange failed. Start Connect GitHub again.',
      );
    }

    const tokens = githubTokenResponseSchema.safeParse(await tokenResponse.json());

    if (!tokens.success) {
      throw new GitHubCallbackError(
        502,
        'GitHub did not return valid credentials. Start Connect GitHub again.',
      );
    }

    const profileResponse = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${tokens.data.access_token}`,
        'User-Agent': 'DeployMe',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });

    if (!profileResponse.ok) {
      throw new GitHubCallbackError(
        502,
        'Unable to verify the GitHub account. Start Connect GitHub again.',
      );
    }

    const profile = githubUserResponseSchema.safeParse(await profileResponse.json());

    if (!profile.success) {
      throw new GitHubCallbackError(502, 'GitHub returned an invalid account response.');
    }

    const githubUserId = BigInt(profile.data.id);

    const credentials = {
      githubLogin: profile.data.login,
      accessTokenEncrypted: encryptGitHubToken(tokens.data.access_token, userId, 'access'),
      refreshTokenEncrypted: tokens.data.refresh_token
        ? encryptGitHubToken(tokens.data.refresh_token, userId, 'refresh')
        : null,
      accessTokenExpiresAt: tokens.data.expires_in
        ? new Date(tokenRequestedAt + tokens.data.expires_in * 1000)
        : null,
      refreshTokenExpiresAt: tokens.data.refresh_token_expires_in
        ? new Date(tokenRequestedAt + tokens.data.refresh_token_expires_in * 1000)
        : null,
    };

    const connection = await prisma.$transaction(
      async (tx) => {
        const activeSession = await tx.session.findFirst({
          where: {
            id: sessionId,
            userId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });

        if (!activeSession) {
          throw new GitHubCallbackError(
            401,
            'Your DeployMe session ended. Sign in and connect GitHub again.',
          );
        }

        const existing = await tx.gitHubConnection.findUnique({
          where: { userId },
          select: { githubUserId: true },
        });

        if (existing && existing.githubUserId !== githubUserId) {
          throw new GitHubCallbackError(
            409,
            'A different GitHub account is already linked to this DeployMe account.',
          );
        }

        return tx.gitHubConnection.upsert({
          where: { userId },
          create: {
            userId,
            githubUserId,
            ...credentials,
          },
          update: credentials,
          select: {
            githubLogin: true,
            createdAt: true,
            updatedAt: true,
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    res.status(200).json({
      message: 'GitHub connected successfully.',
      connection,
    });
  } catch (error: unknown) {
    if (error instanceof GitHubCallbackError) {
      res.status(error.status).json({
        error: { message: error.message },
      });
      return;
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2002' || error.code === 'P2034')
    ) {
      res.status(409).json({
        error: {
          message:
            'The GitHub connection conflicted with another connection. Check the linked account and start Connect GitHub again.',
        },
      });
      return;
    }

    res.status(500).json({
      error: {
        message: 'Unable to complete GitHub authorization. Start Connect GitHub again.',
      },
    });
  }
});
const installationListQuerySchema = z.object({
  page: z
    .string()
    .regex(/^[1-9]\d*$/)
    .default('1')
    .transform(Number)
    .pipe(z.number().int().positive().safe()),
});

const githubInstallationListSchema = z.object({
  total_count: z.number().int().nonnegative(),
  installations: z.array(
    z.object({
      id: z.number().int().positive().safe(),
      account: z
        .object({
          login: z.string().min(1),
          type: z.string().min(1),
        })
        .nullable(),
      repository_selection: z.enum(['all', 'selected']),
      suspended_at: z.string().nullable(),
    }),
  ),
});

githubIntegrationRouter.get('/installations', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const query = installationListQuerySchema.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({
      error: { message: 'Provide a valid positive page number.' },
    });
    return;
  }

  try {
    const userId = res.locals.authenticatedUser.id;

    const accessToken = await getGitHubUserAccessToken(userId);

    const url = new URL('https://api.github.com/user/installations');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(query.data.page));

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'DeployMe',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 401) {
      res.status(409).json({
        error: {
          code: 'GITHUB_REAUTHORIZATION_REQUIRED',
          message: 'GitHub authorization is no longer valid. Connect GitHub again.',
        },
      });
      return;
    }

    if (!response.ok) {
      res.status(502).json({
        error: {
          message: 'GitHub could not list your installations. Please retry later.',
        },
      });
      return;
    }

    const result = githubInstallationListSchema.safeParse(await response.json());

    if (!result.success) {
      res.status(502).json({
        error: { message: 'GitHub returned an invalid installation list.' },
      });
      return;
    }

    const hasNextPage = /rel="next"/.test(response.headers.get('link') ?? '');

    res.status(200).json({
      installations: result.data.installations.map((installation) => ({
        installationId: installation.id,
        accountLogin: installation.account?.login ?? null,
        accountType: installation.account?.type ?? null,
        repositorySelection: installation.repository_selection,
        suspended: installation.suspended_at !== null,
      })),
      totalCount: result.data.total_count,
      nextPage: hasNextPage ? query.data.page + 1 : null,
    });
  } catch (error: unknown) {
    if (error instanceof GitHubUserTokenError) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    res.status(500).json({
      error: { message: 'Unable to load GitHub repositories.' },
    });
  }
});
const githubRepositoryListSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(
    z.object({
      id: z.number().int().positive().safe(),
      name: z.string().min(1),
      full_name: z.string().min(1),
      private: z.boolean(),
      default_branch: z.string().nullable(),
      html_url: z.string().url(),
      archived: z.boolean(),
      disabled: z.boolean(),
      owner: z.object({
        login: z.string().min(1),
      }),
    }),
  ),
});

githubIntegrationRouter.get(
  '/installations/:installationId/repositories',
  requireAuth,
  async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    const installationIdResult = z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().positive().safe())
      .safeParse(req.params.installationId);

    const query = installationListQuerySchema.safeParse(req.query);

    if (!installationIdResult.success || !query.success) {
      res.status(400).json({
        error: {
          message: 'Provide a valid installation ID and positive page number.',
        },
      });
      return;
    }

    try {
      const userId = res.locals.authenticatedUser.id;

      const accessToken = await getGitHubUserAccessToken(userId);

      const installationId = installationIdResult.data;
      const url = new URL(
        `https://api.github.com/user/installations/${installationId}/repositories`,
      );

      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(query.data.page));

      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'DeployMe',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });

      if (response.status === 401) {
        res.status(409).json({
          error: {
            code: 'GITHUB_REAUTHORIZATION_REQUIRED',
            message: 'GitHub authorization is no longer valid. Connect GitHub again.',
          },
        });
        return;
      }

      if (response.status === 404) {
        res.status(404).json({
          error: {
            message: 'The installation was not found or is not accessible to your GitHub account.',
          },
        });
        return;
      }

      if (response.status === 403) {
        res.status(403).json({
          error: {
            message:
              'GitHub refused this request. Check repository access or retry later if a rate limit was reached.',
          },
        });
        return;
      }

      if (!response.ok) {
        res.status(502).json({
          error: {
            message: 'GitHub could not list your repositories. Please retry later.',
          },
        });
        return;
      }

      const result = githubRepositoryListSchema.safeParse(await response.json());

      if (!result.success) {
        res.status(502).json({
          error: { message: 'GitHub returned an invalid repository list.' },
        });
        return;
      }

      const hasNextPage = /rel="next"/.test(response.headers.get('link') ?? '');

      res.status(200).json({
        installationId,
        repositories: result.data.repositories.map((repository) => ({
          repositoryId: repository.id,
          owner: repository.owner.login,
          name: repository.name,
          fullName: repository.full_name,
          private: repository.private,
          defaultBranch: repository.default_branch,
          htmlUrl: repository.html_url,
          archived: repository.archived,
          disabled: repository.disabled,
        })),
        totalCount: result.data.total_count,
        nextPage: hasNextPage ? query.data.page + 1 : null,
      });
    } catch {
      res.status(500).json({
        error: { message: 'Unable to load GitHub repositories.' },
      });
    }
  },
);
const inspectGitHubProjectSchema = z
  .object({
    installationId: z.number().int().positive().safe(),
    repositoryId: z.number().int().positive().safe(),
    owner: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_-]+$/),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/)
      .refine((value) => value !== '.' && value !== '..'),
    rootDirectory: z.string().trim().min(1).max(255).default('.'),
  })
  .strict();

githubIntegrationRouter.post('/inspect', requireTrustedOrigin, requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const input = inspectGitHubProjectSchema.safeParse(req.body);

  if (!input.success) {
    res.status(400).json({
      error: {
        message: 'Provide valid repository details and an app folder.',
        details: input.error.flatten().fieldErrors,
      },
    });
    return;
  }

  try {
    const inspection = await inspectGitHubProject(res.locals.authenticatedUser.id, input.data);

    res.status(200).json({ inspection });
  } catch (error: unknown) {
    if (error instanceof GitHubInspectionError || error instanceof GitHubUserTokenError) {
      res.status(error.status).json({
        error: { message: error.message },
      });
      return;
    }

    if (error instanceof ProjectServiceError) {
      const statusByCode: Record<string, number> = {
        GITHUB_CONNECTION_REQUIRED: 409,
        GITHUB_REAUTHORIZATION_REQUIRED: 409,
        GITHUB_USER_REPOSITORY_ACCESS_DENIED: 403,
        GITHUB_ACCESS_CHECK_FAILED: 502,
        GITHUB_TOKEN_REFRESH_FAILED: 502,
        GITHUB_AUTHORIZATION_NOT_CONFIGURED: 503,
      };

      res.status(statusByCode[error.code] ?? 400).json({
        error: { message: error.message },
      });
      return;
    }

    res.status(502).json({
      error: {
        message: 'Unable to inspect the repository. Please retry later.',
      },
    });
  }
});
