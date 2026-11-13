-- CreateTable
CREATE TABLE "GitHubAppInstallation" (
    "id" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "accountLogin" VARCHAR(255) NOT NULL,
    "accountType" VARCHAR(50) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubAppInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitRepository" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "installationRecordId" TEXT NOT NULL,
    "providerRepositoryId" BIGINT NOT NULL,
    "owner" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "defaultBranch" VARCHAR(255) NOT NULL,
    "productionBranch" VARCHAR(255) NOT NULL DEFAULT 'main',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitRepository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubWebhookDelivery" (
    "id" TEXT NOT NULL,
    "deliveryId" VARCHAR(255) NOT NULL,
    "event" VARCHAR(100) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" VARCHAR(50) NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,

    CONSTRAINT "GitHubWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GitHubAppInstallation_installationId_key" ON "GitHubAppInstallation"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "GitRepository_projectId_key" ON "GitRepository"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GitRepository_providerRepositoryId_key" ON "GitRepository"("providerRepositoryId");

-- CreateIndex
CREATE INDEX "GitRepository_installationRecordId_idx" ON "GitRepository"("installationRecordId");

-- CreateIndex
CREATE INDEX "GitRepository_owner_name_idx" ON "GitRepository"("owner", "name");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubWebhookDelivery_deliveryId_key" ON "GitHubWebhookDelivery"("deliveryId");

-- CreateIndex
CREATE INDEX "GitHubWebhookDelivery_status_receivedAt_idx" ON "GitHubWebhookDelivery"("status", "receivedAt");

-- AddForeignKey
ALTER TABLE "GitRepository" ADD CONSTRAINT "GitRepository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitRepository" ADD CONSTRAINT "GitRepository_installationRecordId_fkey" FOREIGN KEY ("installationRecordId") REFERENCES "GitHubAppInstallation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
