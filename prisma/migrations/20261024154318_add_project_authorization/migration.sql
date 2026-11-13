-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'QUEUED', 'BUILDING', 'READY', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdministratorAccessScope" AS ENUM ('PROJECT_METADATA', 'PROJECT_PRIVATE_DATA', 'PROJECT_SECRETS', 'DEPLOYMENT_DETAILS');

-- CreateEnum
CREATE TYPE "AdministratorAccessStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AdministratorAccessAuditAction" AS ENUM ('REQUESTED', 'APPROVED', 'DENIED', 'ACCESSED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectShare" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "grantedByUserId" INTEGER NOT NULL,
    "canView" BOOLEAN NOT NULL DEFAULT true,
    "canDeploy" BOOLEAN NOT NULL DEFAULT false,
    "canManage" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSecret" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "valueCiphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdministratorAccessGrant" (
    "id" TEXT NOT NULL,
    "requesterUserId" INTEGER NOT NULL,
    "approverUserId" INTEGER NOT NULL,
    "administratorUserId" INTEGER NOT NULL,
    "projectId" TEXT,
    "reason" VARCHAR(1000) NOT NULL,
    "scope" "AdministratorAccessScope" NOT NULL,
    "status" "AdministratorAccessStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AdministratorAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdministratorAccessAudit" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "actorUserId" INTEGER NOT NULL,
    "action" "AdministratorAccessAuditAction" NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdministratorAccessAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_teamId_archivedAt_idx" ON "Project"("teamId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Project_teamId_slug_key" ON "Project"("teamId", "slug");

-- CreateIndex
CREATE INDEX "ProjectShare_userId_canView_idx" ON "ProjectShare"("userId", "canView");

-- CreateIndex
CREATE INDEX "ProjectShare_projectId_canDeploy_idx" ON "ProjectShare"("projectId", "canDeploy");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectShare_projectId_userId_key" ON "ProjectShare"("projectId", "userId");

-- CreateIndex
CREATE INDEX "Deployment_projectId_createdAt_idx" ON "Deployment"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Deployment_status_createdAt_idx" ON "Deployment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectSecret_projectId_idx" ON "ProjectSecret"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSecret_projectId_name_key" ON "ProjectSecret"("projectId", "name");

-- CreateIndex
CREATE INDEX "AdministratorAccessGrant_administratorUserId_status_expires_idx" ON "AdministratorAccessGrant"("administratorUserId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "AdministratorAccessGrant_requesterUserId_requestedAt_idx" ON "AdministratorAccessGrant"("requesterUserId", "requestedAt");

-- CreateIndex
CREATE INDEX "AdministratorAccessGrant_projectId_status_idx" ON "AdministratorAccessGrant"("projectId", "status");

-- CreateIndex
CREATE INDEX "AdministratorAccessAudit_grantId_createdAt_idx" ON "AdministratorAccessAudit"("grantId", "createdAt");

-- CreateIndex
CREATE INDEX "AdministratorAccessAudit_actorUserId_createdAt_idx" ON "AdministratorAccessAudit"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectShare" ADD CONSTRAINT "ProjectShare_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectShare" ADD CONSTRAINT "ProjectShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectShare" ADD CONSTRAINT "ProjectShare_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSecret" ADD CONSTRAINT "ProjectSecret_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdministratorAccessGrant" ADD CONSTRAINT "AdministratorAccessGrant_requesterUserId_fkey" FOREIGN KEY ("requesterUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdministratorAccessGrant" ADD CONSTRAINT "AdministratorAccessGrant_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdministratorAccessGrant" ADD CONSTRAINT "AdministratorAccessGrant_administratorUserId_fkey" FOREIGN KEY ("administratorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdministratorAccessAudit" ADD CONSTRAINT "AdministratorAccessAudit_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "AdministratorAccessGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdministratorAccessAudit" ADD CONSTRAINT "AdministratorAccessAudit_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
