-- CreateEnum
CREATE TYPE "ArtifactUploadAttemptStatus" AS ENUM ('UPLOADING', 'ADOPTED', 'CLEANUP_PENDING', 'CLEANED');

-- CreateTable
CREATE TABLE "ArtifactUploadAttempt" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "processingToken" TEXT NOT NULL,
    "artifactBucket" TEXT NOT NULL,
    "artifactPrefix" TEXT NOT NULL,
    "status" "ArtifactUploadAttemptStatus" NOT NULL DEFAULT 'UPLOADING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "adoptedAt" TIMESTAMP(3),
    "cleanupAfter" TIMESTAMP(3),
    "cleanedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "ArtifactUploadAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArtifactUploadAttempt_status_cleanupAfter_idx" ON "ArtifactUploadAttempt"("status", "cleanupAfter");

-- CreateIndex
CREATE INDEX "ArtifactUploadAttempt_status_claimedAt_idx" ON "ArtifactUploadAttempt"("status", "claimedAt");

-- CreateIndex
CREATE INDEX "ArtifactUploadAttempt_projectId_idx" ON "ArtifactUploadAttempt"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactUploadAttempt_deploymentId_processingToken_key" ON "ArtifactUploadAttempt"("deploymentId", "processingToken");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactUploadAttempt_artifactBucket_artifactPrefix_key" ON "ArtifactUploadAttempt"("artifactBucket", "artifactPrefix");
