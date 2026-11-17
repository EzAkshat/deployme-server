import type { Prisma } from '../generated/prisma/client.js';
import { ProjectAuthorizationError } from './project-authorization.js';

export class AccountSuspendedError extends ProjectAuthorizationError {
  constructor() {
    super('ACCOUNT_SUSPENDED', 'This account is suspended and cannot request deployments.');
    this.name = 'AccountSuspendedError';
  }
}

// Call inside the transaction that creates the deployment.
// The future suspension operation must acquire the same User lock.
export async function lockActiveAccount(
  tx: Prisma.TransactionClient,
  userId: number,
): Promise<void> {
  await tx.$queryRaw`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${userId}
    FOR UPDATE
  `;

  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { suspendedAt: true },
  });

  if (!user) {
    throw new ProjectAuthorizationError('ACCOUNT_NOT_FOUND', 'The account is unavailable.');
  }

  if (user.suspendedAt !== null) {
    throw new AccountSuspendedError();
  }
}
