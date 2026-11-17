-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PlatformAdminAuditAction" ADD VALUE 'USER_SUSPENDED';
ALTER TYPE "PlatformAdminAuditAction" ADD VALUE 'USER_RESTORED';

-- AlterTable
ALTER TABLE "PlatformAdminAudit" ADD COLUMN     "nextSuspendedAt" TIMESTAMP(3),
ADD COLUMN     "previousSuspendedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accountStateVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "suspendedAt" TIMESTAMP(3);
