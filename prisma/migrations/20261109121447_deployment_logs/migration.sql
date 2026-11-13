-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "logBytes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "logText" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "logTruncated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "logUpdatedAt" TIMESTAMP(3);
