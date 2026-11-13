import { prisma } from '../config/database.js';

export type ProjectPermission = 'VIEW' | 'DEPLOY' | 'MANAGE';

export class ProjectAuthorizationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectAuthorizationError';
  }
}

async function hasProjectPermission(
  userId: number,
  projectId: string,
  permission: ProjectPermission,
): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      archivedAt: true,
      ownerUserId: true,
      teamId: true,
      team: {
        select: {
          memberships: {
            where: { userId },
            select: { role: true },
          },
        },
      },
      shares: {
        where: { userId },
        select: {
          canView: true,
          canDeploy: true,
          canManage: true,
        },
      },
    },
  });

  if (!project || project.archivedAt !== null) {
    return false;
  }

  // Personal projects must have an owner and no team.
  if (project.ownerUserId !== null) {
    return (
      project.teamId === null &&
      project.ownerUserId === userId
    );
  }

  if (project.teamId === null) {
    return false;
  }

  // A leftover share never substitutes for current team membership.
  const membership = project.team?.memberships[0];

  if (!membership) {
    return false;
  }

  const share = project.shares[0];
  const isManager =
    membership.role === 'OWNER' ||
    membership.role === 'MANAGER';

  switch (permission) {
    case 'VIEW':
      return isManager || share?.canView === true;

    case 'DEPLOY':
      // Every team role requires an explicit deployment grant.
      return share?.canDeploy === true;

    case 'MANAGE':
      return isManager || share?.canManage === true;

    default:
      return false;
  }
}

export async function canViewProject(
  userId: number,
  projectId: string,
): Promise<boolean> {
  return hasProjectPermission(userId, projectId, 'VIEW');
}

export async function canDeployToProject(
  userId: number,
  projectId: string,
): Promise<boolean> {
  return hasProjectPermission(userId, projectId, 'DEPLOY');
}

export async function canManageProject(
  userId: number,
  projectId: string,
): Promise<boolean> {
  return hasProjectPermission(userId, projectId, 'MANAGE');
}

export async function requireProjectPermission(
  userId: number,
  projectId: string,
  permission: ProjectPermission,
): Promise<void> {
  const allowed = await hasProjectPermission(
    userId,
    projectId,
    permission,
  );

  if (!allowed) {
    throw new ProjectAuthorizationError(
      'PROJECT_ACCESS_DENIED',
      'The project was not found or you do not have permission to perform this action.',
    );
  }
}