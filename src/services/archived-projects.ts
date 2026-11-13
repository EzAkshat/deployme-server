import { prisma } from '../config/database.js';
import { Prisma } from '../generated/prisma/client.js';
import { ProjectServiceError } from './projects.js';

const archivedProjectSelect = {
  id: true,
  ownerUserId: true,
  teamId: true,
  name: true,
  slug: true,
  subdomain: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
  archiveOutbox: {
    select: {
      processedAt: true,
    },
  },
} satisfies Prisma.ProjectSelect;

type ArchivedProject = Prisma.ProjectGetPayload<{
  select: typeof archivedProjectSelect;
}>;

function formatArchivedProject(project: ArchivedProject) {
  const { archiveOutbox, ...details } = project;

  const deliveryDisableStatus:
    | 'completed'
    | 'pending'
    | 'not_queued' =
    archiveOutbox === null
      ? 'not_queued'
      : archiveOutbox.processedAt === null
        ? 'pending'
        : 'completed';

  return {
    ...details,
    deliveryDisableStatus,
    deliveryDisabledAt: archiveOutbox?.processedAt ?? null,
  };
}

export async function listArchivedPersonalProjects(userId: number) {
  const projects = await prisma.project.findMany({
    where: {
      ownerUserId: userId,
      teamId: null,
      archivedAt: { not: null },
    },
    select: archivedProjectSelect,
    orderBy: [{ archivedAt: 'desc' }, { id: 'desc' }],
  });

  return projects.map(formatArchivedProject);
}

export async function listArchivedTeamProjects(
  userId: number,
  teamId: string,
) {
  const membership = await prisma.teamMembership.findUnique({
    where: {
      teamId_userId: {
        teamId,
        userId,
      },
    },
    select: { role: true },
  });

  if (!membership) {
    throw new ProjectServiceError(
      'TEAM_ACCESS_DENIED',
      'The team was not found or you are not a member.',
    );
  }

  const isManager =
    membership.role === 'OWNER' || membership.role === 'MANAGER';

  const projects = await prisma.project.findMany({
    where: {
      teamId,
      ownerUserId: null,
      archivedAt: { not: null },
      ...(isManager
        ? {}
        : {
            shares: {
              some: {
                userId,
                canView: true,
              },
            },
          }),
    },
    select: archivedProjectSelect,
    orderBy: [{ archivedAt: 'desc' }, { id: 'desc' }],
  });

  return projects.map(formatArchivedProject);
}