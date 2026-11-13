-- CreateTable
CREATE TABLE "ProjectArchiveOutbox" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,

    CONSTRAINT "ProjectArchiveOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectArchiveOutbox_projectId_key" ON "ProjectArchiveOutbox"("projectId");

-- CreateIndex
CREATE INDEX "ProjectArchiveOutbox_processedAt_nextAttemptAt_idx" ON "ProjectArchiveOutbox"("processedAt", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "ProjectArchiveOutbox" ADD CONSTRAINT "ProjectArchiveOutbox_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
