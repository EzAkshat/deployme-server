import { prisma } from '../config/database.js';

const PAGE_SIZE = 25;

export interface ListAdminUsersInput {
  after?: number;
  search?: string;
}

export async function listAdminUsers(input: ListAdminUsersInput) {
  const search = input.search?.trim();

  const rows = await prisma.user.findMany({
    where: {
      ...(input.after !== undefined ? { id: { gt: input.after } } : {}),
      ...(search
        ? {
            OR: [
              {
                email: {
                  contains: search,
                  mode: 'insensitive' as const,
                },
              },
              {
                username: {
                  contains: search,
                  mode: 'insensitive' as const,
                },
              },
              {
                name: {
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
      username: true,
      name: true,
      email: true,
      platformRole: true,
      createdAt: true,
      onboardingCompletedAt: true,
      suspendedAt: true,
      accountStateVersion: true,
    },
  });

  const users = rows.slice(0, PAGE_SIZE);
  const last = users.at(-1);

  return {
    users,
    nextCursor: rows.length > PAGE_SIZE && last ? String(last.id) : null,
  };
}
