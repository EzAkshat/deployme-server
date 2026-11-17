import { prisma } from '../config/database.js';

export type ProjectPermission = 'VIEW' | 'DEPLOY' | 'MANAGE';

export interface ProjectPermissions {
  canView: boolean;
  canDeploy: boolean;
  canManage: boolean;
  canManageSharing: boolean;
}

export class ProjectAuthorizationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectAuthorizationError';
  }
}

export async function getProjectPermissions(
  userId: number,
  projectId: string,
): Promise<ProjectPermissions> {
  const denied: ProjectPermissions = {
    canView: false,
    canDeploy: false,
    canManage: false,
    canManageSharing: false,
  };

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
    return denied;
  }
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { suspendedAt: true },
  });

  if (!account || account.suspendedAt !== null) {
    return denied;
  }
  if (project.ownerUserId !== null) {
    if (project.teamId !== null || project.ownerUserId !== userId) {
      return denied;
    }

    return {
      canView: true,
      canDeploy: true,
      canManage: true,
      canManageSharing: false,
    };
  }

  if (project.teamId === null) {
    return denied;
  }

  // A share never substitutes for current team membership.
  const membership = project.team?.memberships[0];

  if (!membership) {
    return denied;
  }

  const share = project.shares[0];
  const isManager = membership.role === 'OWNER' || membership.role === 'MANAGER';

  return {
    canView: isManager || share?.canView === true,
    canDeploy: share?.canDeploy === true,
    canManage: isManager || share?.canManage === true,
    canManageSharing: isManager,
  };
}

async function hasProjectPermission(
  userId: number,
  projectId: string,
  permission: ProjectPermission,
): Promise<boolean> {
  const permissions = await getProjectPermissions(userId, projectId);

  switch (permission) {
    case 'VIEW':
      return permissions.canView;
    case 'DEPLOY':
      return permissions.canDeploy;
    case 'MANAGE':
      return permissions.canManage;
    default:
      return false;
  }
}

export async function canViewProject(userId: number, projectId: string): Promise<boolean> {
  return hasProjectPermission(userId, projectId, 'VIEW');
}

export async function canDeployToProject(userId: number, projectId: string): Promise<boolean> {
  return hasProjectPermission(userId, projectId, 'DEPLOY');
}

export async function canManageProject(userId: number, projectId: string): Promise<boolean> {
  return hasProjectPermission(userId, projectId, 'MANAGE');
}

export async function requireProjectPermission(
  userId: number,
  projectId: string,
  permission: ProjectPermission,
): Promise<void> {
  const allowed = await hasProjectPermission(userId, projectId, permission);

  if (!allowed) {
    throw new ProjectAuthorizationError(
      'PROJECT_ACCESS_DENIED',
      'The project was not found or you do not have permission to perform this action.',
    );
  }
}
