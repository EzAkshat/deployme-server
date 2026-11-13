import { App } from '@octokit/app';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const ARCHIVE_TIMEOUT_MS = 60_000;
const ALLOWED_ARCHIVE_HOSTS = new Set(['codeload.github.com', 'github.com']);

function createGitHubApp(): App {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error('GitHub App is not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.');
  }

  return new App({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
}

function validateInstallationId(installationId: number): void {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('Invalid GitHub App installation ID');
  }
}

function validateRepositoryIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 100 &&
    /^[A-Za-z0-9_.-]+$/.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

export async function getInstallationAccessToken(installationId: number): Promise<string> {
  validateInstallationId(installationId);

  const app = createGitHubApp();
  const installation = await app.getInstallationOctokit(installationId);

  const response = await installation.request(
    'POST /app/installations/{installation_id}/access_tokens',
    { installation_id: installationId },
  );

  return response.data.token;
}

export async function listInstallationRepositories(installationId: number) {
  validateInstallationId(installationId);

  const app = createGitHubApp();
  const octokit = await app.getInstallationOctokit(installationId);

  const repositories: {
    id: number;
    name: string;
    fullName: string;
    private: boolean;
    defaultBranch: string | null;
    htmlUrl: string;
  }[] = [];

  let page = 1;

  while (true) {
    const response = await octokit.request('GET /installation/repositories', {
      per_page: 100,
      page,
    });

    repositories.push(
      ...response.data.repositories.map((repository) => ({
        id: Number(repository.id),
        name: repository.name,
        fullName: repository.full_name,
        private: repository.private,
        defaultBranch: repository.default_branch,
        htmlUrl: repository.html_url,
      })),
    );

    if (response.data.repositories.length < 100) {
      break;
    }

    page += 1;
  }

  return repositories;
}

export async function saveGitHubInstallation(input: {
  installationId: number;
  accountLogin: string;
  accountType: string;
}) {
  validateInstallationId(input.installationId);

  const installationId = BigInt(input.installationId);

  return prisma.gitHubAppInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      accountLogin: input.accountLogin,
      accountType: input.accountType,
    },
    update: {
      accountLogin: input.accountLogin,
      accountType: input.accountType,
    },
  });
}

export async function syncGitHubInstallation(installationId: number) {
  validateInstallationId(installationId);

  const app = createGitHubApp();
  const octokit = await app.getInstallationOctokit(installationId);

  const response = await octokit.request('GET /app/installations/{installation_id}', {
    installation_id: installationId,
  });

  const account = response.data.account;

  if (!account) {
    throw new Error('GitHub installation has no associated account');
  }

  const accountLogin = 'login' in account ? account.login : account.slug;
  const accountType = 'type' in account ? account.type : 'Organization';

  return saveGitHubInstallation({
    installationId,
    accountLogin,
    accountType,
  });
}

export async function getConnectedRepositoryForDeployment(projectId: string) {
  return prisma.gitRepository.findFirst({
    where: {
      projectId,
      project: {
        archivedAt: null,
      },
    },
    select: {
      projectId: true,
      installation: {
        select: {
          installationId: true,
        },
      },
      providerRepositoryId: true,
      owner: true,
      name: true,
      productionBranch: true,
    },
  });
}
export async function getProductionBranchCommitSha(projectId: string) {
  const repository = await getConnectedRepositoryForDeployment(projectId);

  if (!repository) {
    throw new Error('The project has no connected GitHub repository or is archived.');
  }

  const installationId = Number(repository.installation.installationId);
  validateInstallationId(installationId);

  const app = createGitHubApp();
  const octokit = await app.getInstallationOctokit(installationId);

  const response = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
    owner: repository.owner,
    repo: repository.name,
    ref: repository.productionBranch,
  });

  const commitSha = response.data.sha;

  if (!/^[a-f0-9]{40}$/i.test(commitSha)) {
    throw new Error('GitHub returned an invalid commit SHA.');
  }

  return commitSha;
}
export async function downloadRepositoryArchive(
  installationId: number,
  owner: string,
  repo: string,
  commitSha: string,
): Promise<Buffer> {
  validateInstallationId(installationId);

  if (
    !validateRepositoryIdentifier(owner) ||
    !validateRepositoryIdentifier(repo) ||
    !/^[a-f0-9]{40}$/i.test(commitSha)
  ) {
    throw new Error('Invalid GitHub repository archive parameters');
  }

  const app = createGitHubApp();
  const octokit = await app.getInstallationOctokit(installationId);

  const response = await octokit.request('GET /repos/{owner}/{repo}/zipball/{ref}', {
    owner,
    repo,
    ref: commitSha,
    request: {
      headers: {
        accept: 'application/vnd.github+json',
      },
      redirect: 'manual',
    },
  });

  const downloadUrl = response.headers.location;

  if (response.status !== 302 || typeof downloadUrl !== 'string') {
    throw new Error('GitHub did not return a valid archive download redirect');
  }

  let parsedDownloadUrl: URL;

  try {
    parsedDownloadUrl = new URL(downloadUrl);
  } catch {
    throw new Error('GitHub returned an invalid archive download URL');
  }

  if (
    parsedDownloadUrl.protocol !== 'https:' ||
    parsedDownloadUrl.username !== '' ||
    parsedDownloadUrl.password !== '' ||
    !ALLOWED_ARCHIVE_HOSTS.has(parsedDownloadUrl.hostname) ||
    parsedDownloadUrl.port !== ''
  ) {
    throw new Error('GitHub returned an untrusted archive download URL');
  }

  const archiveResponse = await fetch(parsedDownloadUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
  });

  if (!archiveResponse.ok) {
    await archiveResponse.body?.cancel();
    throw new Error('Failed to download GitHub repository archive');
  }

  const contentLength = archiveResponse.headers.get('content-length');

  if (contentLength !== null) {
    const declaredSize = Number(contentLength);

    if (
      !Number.isSafeInteger(declaredSize) ||
      declaredSize < 0 ||
      declaredSize > MAX_ARCHIVE_BYTES
    ) {
      await archiveResponse.body?.cancel();
      throw new Error('GitHub repository archive exceeds the size limit');
    }
  }

  if (!archiveResponse.body) {
    throw new Error('GitHub repository archive response has no body');
  }

  const reader = archiveResponse.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > MAX_ARCHIVE_BYTES) {
        throw new Error('GitHub repository archive exceeds the size limit');
      }

      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}
