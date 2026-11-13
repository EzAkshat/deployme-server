-- AlterTable
ALTER TABLE "DeploymentOutbox" ADD COLUMN     "claimToken" TEXT,
ADD COLUMN     "claimedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "DeploymentOutbox_claimedAt_processedAt_createdAt_idx" ON "DeploymentOutbox"("claimedAt", "processedAt", "createdAt");
