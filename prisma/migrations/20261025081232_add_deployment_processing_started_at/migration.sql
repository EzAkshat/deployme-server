-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "processingStartedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Deployment_status_processingStartedAt_idx" ON "Deployment"("status", "processingStartedAt");
