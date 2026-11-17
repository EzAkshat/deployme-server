import { prisma } from '../config/database.js';

const PAGE_SIZE = 25;

interface ListAdminProjectsInput {
  search?: string;
  after?: string;
}

export async function listAdminProjects(input: ListAdminProjectsInput) {
  const search = input.search?.trim() ?? '';

  return prisma.$transaction(async (tx) => {
    const rows = await tx.project.findMany({
      where: {
        ...(input.after ? { id: { gt: input.after } } : {}),
        ...(search
          ? {
              OR: [
                {
                  name: {
                    contains: search,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  slug: {
                    contains: search,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  subdomain: {
                    contains: search,
                    mode: 'insensitive' as const,
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE + 1,
      select: {
        id: true,
        name: true,
        slug: true,
        subdomain: true,
        archivedAt: true,
        ownerUser: {
          select: {
            id: true,
            username: true,
            suspendedAt: true,
          },
        },
        team: {
          select: {
            id: true,
            name: true,
          },
        },
        deployments: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: {
            id: true,
            status: true,
            createdAt: true,
            buildStartedAt: true,
            buildFinishedAt: true,
          },
        },
      },
    });

    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);

    // Query publication history independently of the latest deployment.
    const publications = page.length === 0
      ? []
      : await tx.project.findMany({
          where: { id: { in: page.map((project) => project.id) } },
          select: {
            id: true,
            deployments: {
              where: { publishedAt: { not: null } },
              orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
              take: 1,
              select: {
                id: true,
                publishedAt: true,
              },
            },
          },
        });

    const publicationByProject = new Map(
      publications.map((project) => [
        project.id,
        project.deployments[0] ?? null,
      ]),
    );

    return {
      projects: page.map((project) => ({
        id: project.id,
        name: project.name,
        slug: project.slug,
        subdomain: project.subdomain,
        archivedAt: project.archivedAt,
        ownerUser: project.ownerUser,
        team: project.team,
        latestDeployment: project.deployments[0] ?? null,
        lastRecordedPublication:
          publicationByProject.get(project.id) ?? null,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }, {
    isolationLevel: 'RepeatableRead',
  });
}