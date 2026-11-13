-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "artifactFileCount" INTEGER,
ADD COLUMN     "artifactSizeBytes" INTEGER,
ADD COLUMN     "buildFinishedAt" TIMESTAMP(3),
ADD COLUMN     "buildStartedAt" TIMESTAMP(3);
