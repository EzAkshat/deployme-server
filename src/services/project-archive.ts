import { prisma } from '../config/database.js';
import { ProjectAuthorizationError } from './project-authorization.js';

export async function archiveProject(userId: number, projectId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "Project"
      WHERE "id" = ${projectId}
      FOR UPDATE
    `;

    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        ownerUserId: true,
        archivedAt: true,
        subdomain: true,
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
          select: { canManage: true },
        },
      },
    });

    const membership = project?.team?.memberships[0];

    const allowed =
      project !== null &&
      (
        project.ownerUserId !== null
          ? project.ownerUserId === userId
          : membership !== undefined &&
            (
              membership.role === 'OWNER' ||
              membership.role === 'MANAGER' ||
              project.shares[0]?.canManage === true
            )
      );

    if (!project || !allowed) {
      throw new ProjectAuthorizationError(
        'PROJECT_ACCESS_DENIED',
        'The project was not found or you do not have permission to archive it.',
      );
    }

    const alreadyArchived = project.archivedAt !== null;
    const archivedAt = project.archivedAt ?? new Date();

    if (!alreadyArchived) {
      await tx.project.update({
        where: { id: projectId },
        data: { archivedAt },
      });
    }

    // The unique projectId makes repeated archive requests idempotent.
    const event = await tx.projectArchiveOutbox.upsert({
      where: { projectId },
      create: { projectId },
      update: {},
      select: { processedAt: true },
    });

    return {
      project: {
        id: project.id,
        subdomain: project.subdomain,
        archivedAt,
      },
      alreadyArchived,
      deliveryDisableStatus:
        event.processedAt === null
          ? ('pending' as const)
          : ('completed' as const),
    };
  });
}