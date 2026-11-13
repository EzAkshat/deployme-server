import type { Prisma } from '../generated/prisma/client.js';

export async function lockTeamForMutation(
  tx: Prisma.TransactionClient,
  teamId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT "id"
    FROM "Team"
    WHERE "id" = ${teamId}
    FOR UPDATE
  `;
}