import { prisma } from '../config/database.js';

export async function getAdminOverview() {
  const [users, teams, activeProjects, archivedProjects, deploymentsByStatus] =
    await prisma.$transaction([
      prisma.user.count(),

      prisma.team.count(),

      prisma.project.count({
        where: { archivedAt: null },
      }),

      prisma.project.count({
        where: { archivedAt: { not: null } },
      }),

      prisma.deployment.groupBy({
        by: ['status'],
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
    ]);

  return {
    generatedAt: new Date().toISOString(),
    users: {
      total: users,
    },
    teams: {
      total: teams,
    },
    projects: {
      total: activeProjects + archivedProjects,
      active: activeProjects,
      archived: archivedProjects,
    },
    deployments: {
      total: deploymentsByStatus.reduce((total, group) => total + group._count._all, 0),
      byStatus: deploymentsByStatus.map((group) => ({
        status: group.status,
        count: group._count._all,
      })),
    },
  };
}
