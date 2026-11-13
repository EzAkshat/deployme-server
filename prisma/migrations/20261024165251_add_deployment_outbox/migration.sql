-- CreateTable
CREATE TABLE "DeploymentOutbox" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "DeploymentOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeploymentOutbox_processedAt_createdAt_idx" ON "DeploymentOutbox"("processedAt", "createdAt");

-- CreateIndex
CREATE INDEX "DeploymentOutbox_deploymentId_idx" ON "DeploymentOutbox"("deploymentId");
