import { prisma } from '../config/database.js';
import { getProject } from './projects.js';
import {
  resourceUsageSelect,
  withDeploymentResourceSummary,
} from './deployment-resource-summary.js';
import { getProjectPermissions, ProjectAuthorizationError } from './project-authorization.js';

export class ActivityInputError extends Error {}
export interface ActivityInput {
  before?: string;
  deployment?: string;
}
const PAGE_SIZE = 5;
const deploymentSelect = {
  id: true,
  commitSha: true,
  status: true,
  failureReason: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
  buildStartedAt: true,
  buildFinishedAt: true,
  artifactSizeBytes: true,
  artifactFileCount: true,
  processingAttempt: true,
  resourceUsage: {
    select: resourceUsageSelect,
  },
} as const;

export function decodeActivityCursor(value: string) {
  try {
    if (value.length > 512 || !/^[\w-]+$/.test(value)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(parsed[1])
    )
      throw new Error();
    const createdAt = new Date(parsed[0]);
    if (!Number.isFinite(createdAt.getTime())) throw new Error();
    return { createdAt, id: parsed[1] };
  } catch {
    throw new ActivityInputError('Invalid log history cursor.');
  }
}

export async function getProjectActivity(userId: number, projectId: string, input: ActivityInput) {
  if (input.before && input.deployment)
    throw new ActivityInputError('Choose history or a deployment.');
  const cursor = input.before ? decodeActivityCursor(input.before) : null;
  const project = await getProject(userId, projectId); // Active project + VIEW permission.
  const deployments = await prisma.deployment.findMany({
    where: {
      projectId,
      ...(input.deployment ? { id: input.deployment } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.deployment ? 1 : PAGE_SIZE + 1,
    select: {
      ...deploymentSelect,
      logText: true,
      logBytes: true,
      logTruncated: true,
      logUpdatedAt: true,
    },
  });
  const page = deployments.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  const latestDeployment = await prisma.deployment.findFirst({
    where: { projectId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: deploymentSelect,
  });
  const permissions = await getProjectPermissions(userId, projectId);

  if (!permissions.canView) {
    throw new ProjectAuthorizationError(
      'PROJECT_ACCESS_DENIED',
      'The project was not found or you do not have permission to view it.',
    );
  }
  return {
    project: {
      id: project.id,
      name: project.name,
      permissions,
      delivery: {
        status: project.delivery.status,
        url: project.delivery.url,
        liveDeploymentId: project.delivery.liveDeployment?.id ?? null,
      },
    },
    latestDeployment: latestDeployment ? withDeploymentResourceSummary(latestDeployment) : null,
    deployments: page.map((deployment) => withDeploymentResourceSummary(deployment)),
    nextCursor:
      deployments.length > PAGE_SIZE && last
        ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last.id])).toString('base64url')
        : null,
  };
}
