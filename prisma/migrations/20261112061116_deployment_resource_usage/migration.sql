-- CreateTable
CREATE TABLE "DeploymentResourceUsage" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "processingToken" TEXT NOT NULL,
    "executionNumber" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "lastSampleAt" TIMESTAMP(3),
    "cpuTimeMs" DOUBLE PRECISION,
    "peakObservedMemoryBytes" DOUBLE PRECISION,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "collectionCompleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DeploymentResourceUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentResourceUsage_processingToken_key" ON "DeploymentResourceUsage"("processingToken");

-- CreateIndex
CREATE INDEX "DeploymentResourceUsage_deploymentId_startedAt_idx" ON "DeploymentResourceUsage"("deploymentId", "startedAt");

-- AddForeignKey
ALTER TABLE "DeploymentResourceUsage" ADD CONSTRAINT "DeploymentResourceUsage_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
