-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "artifactBucket" TEXT,
ADD COLUMN     "artifactPrefix" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3);
