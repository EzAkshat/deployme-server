-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "processingAttempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processingJobId" TEXT;
