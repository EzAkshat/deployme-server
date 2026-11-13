-- CreateTable
CREATE TABLE "ProjectImportRequest" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "projectId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectImportRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectImportRequest_projectId_key" ON "ProjectImportRequest"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectImportRequest_deploymentId_key" ON "ProjectImportRequest"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectImportRequest_userId_idempotencyKey_key" ON "ProjectImportRequest"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ProjectImportRequest" ADD CONSTRAINT "ProjectImportRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectImportRequest" ADD CONSTRAINT "ProjectImportRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectImportRequest" ADD CONSTRAINT "ProjectImportRequest_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
