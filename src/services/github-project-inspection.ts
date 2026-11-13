import { z } from 'zod';
import { getGitHubUserAccessToken } from './github-user-token.js';
import { requireGitHubRepositoryAccess } from './projects.js';
import { detectProjectSettings } from './project-detection.js';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);

const repositorySchema = z.object({
  id: z.number().int().positive().safe(),
  default_branch: z.string().min(1),
});

const commitSchema = z.object({
  sha: shaSchema,
  commit: z.object({
    tree: z.object({ sha: shaSchema }),
  }),
});

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: shaSchema,
      size: z.number().int().nonnegative().optional(),
    }),
  ),
});

const blobSchema = z.object({
  encoding: z.literal('base64'),
  content: z.string(),
  size: z.number().int().nonnegative().max(MAX_MANIFEST_BYTES),
});

export class GitHubInspectionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubInspectionError';
  }
}

export interface GitHubInspectionInput {
  installationId: number;
  repositoryId: number;
  owner: string;
  name: string;
  rootDirectory: string;
}

export async function inspectGitHubProject(userId: number, input: GitHubInspectionInput) {
  const segments = input.rootDirectory === '.' ? [] : input.rootDirectory.split('/');

  if (
    segments.length > 20 ||
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || /[\\:\0]/.test(segment),
    )
  ) {
    throw new GitHubInspectionError(400, 'Choose a relative app folder such as "." or "apps/web".');
  }

  await requireGitHubRepositoryAccess(userId, input.installationId, input.repositoryId);

  const accessToken = await getGitHubUserAccessToken(userId);
  const signal = AbortSignal.timeout(30_000);

  const repositoryPath =
    `/repos/${encodeURIComponent(input.owner)}` + `/${encodeURIComponent(input.name)}`;

  async function getJson<T>(endpoint: string, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'DeployMe',
      },
      redirect: 'error',
      signal,
    });

    if (!response.ok || !response.body) {
      await response.body?.cancel();

      if (response.status === 401) {
        throw new GitHubInspectionError(
          409,
          'GitHub authorization is no longer valid. Connect GitHub again.',
        );
      }

      if (response.status === 404 || response.status === 409) {
        throw new GitHubInspectionError(
          422,
          'The repository content is unavailable. Check access and whether the repository has a commit.',
        );
      }

      throw new GitHubInspectionError(
        502,
        'GitHub could not inspect this repository. Please retry later.',
      );
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;

        totalBytes += result.value.length;

        if (totalBytes > MAX_RESPONSE_BYTES) {
          throw new GitHubInspectionError(
            422,
            'Repository metadata exceeds the inspection size limit.',
          );
        }

        chunks.push(Buffer.from(result.value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }

    const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));

    if (!parsed.success) {
      throw new GitHubInspectionError(502, 'GitHub returned an unsupported repository response.');
    }

    return parsed.data;
  }

  const repository = await getJson(repositoryPath, repositorySchema);

  if (repository.id !== input.repositoryId) {
    throw new GitHubInspectionError(
      400,
      'The repository name does not match the selected repository ID.',
    );
  }

  const commit = await getJson(
    `${repositoryPath}/commits/${encodeURIComponent(repository.default_branch)}`,
    commitSchema,
  );

  async function readTree(sha: string) {
    const tree = await getJson(`${repositoryPath}/git/trees/${sha}`, treeSchema);

    if (tree.truncated) {
      throw new GitHubInspectionError(422, 'This folder is too large to inspect completely.');
    }

    return tree.tree;
  }

  let entries = await readTree(commit.commit.tree.sha);

  for (const segment of segments) {
    const directory = entries.find(
      (entry) => entry.path === segment && entry.type === 'tree' && entry.mode === '040000',
    );

    if (!directory) {
      throw new GitHubInspectionError(
        422,
        'The selected app folder does not exist at this commit.',
      );
    }

    entries = await readTree(directory.sha);
  }

  if (entries.some((entry) => entry.mode === '120000' || entry.type === 'commit')) {
    throw new GitHubInspectionError(
      422,
      'This folder contains a symbolic link or Git submodule and needs manual review.',
    );
  }

  const files = entries.filter(
    (entry) => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755'),
  );

  async function readManifest(filename: string): Promise<string | undefined> {
    const file = files.find((entry) => entry.path === filename);
    if (!file) return undefined;

    if (file.size === undefined || file.size > MAX_MANIFEST_BYTES) {
      throw new GitHubInspectionError(422, `${filename} exceeds the inspection size limit.`);
    }

    const blob = await getJson(`${repositoryPath}/git/blobs/${file.sha}`, blobSchema);

    const contents = Buffer.from(blob.content, 'base64');

    if (contents.length !== blob.size || contents.length !== file.size) {
      throw new GitHubInspectionError(502, 'GitHub returned inconsistent file contents.');
    }

    return contents.toString('utf8');
  }

  const packageJson = await readManifest('package.json');
  const packageLockJson = await readManifest('package-lock.json');

  const detection = detectProjectSettings({
    fileNames: files.map((file) => file.path),
    ...(packageJson !== undefined && { packageJson }),
    ...(packageLockJson !== undefined && { packageLockJson }),
  });

  return {
    installationId: input.installationId,
    repositoryId: repository.id,
    defaultBranch: repository.default_branch,
    commitSha: commit.sha,
    rootDirectory: input.rootDirectory,
    fileNames: files.map((file) => file.path),
    folders: entries.filter((entry) => entry.type === 'tree').map((entry) => entry.path),
    ...detection,
  };
}
