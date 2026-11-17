-- CreateEnum
CREATE TYPE "PlatformAdminAuditAction" AS ENUM ('USER_PLATFORM_ROLE_CHANGED');

-- CreateTable
CREATE TABLE "PlatformAdminAudit" (
    "id" TEXT NOT NULL,
    "actorUserId" INTEGER NOT NULL,
    "targetUserId" INTEGER NOT NULL,
    "actorPlatformRole" "PlatformRole" NOT NULL,
    "action" "PlatformAdminAuditAction" NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "previousRole" "PlatformRole" NOT NULL,
    "nextRole" "PlatformRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformAdminAudit_createdAt_id_idx" ON "PlatformAdminAudit"("createdAt", "id");

-- CreateIndex
CREATE INDEX "PlatformAdminAudit_actorUserId_createdAt_id_idx" ON "PlatformAdminAudit"("actorUserId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "PlatformAdminAudit_targetUserId_createdAt_id_idx" ON "PlatformAdminAudit"("targetUserId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "PlatformAdminAudit" ADD CONSTRAINT "PlatformAdminAudit_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAdminAudit" ADD CONSTRAINT "PlatformAdminAudit_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
