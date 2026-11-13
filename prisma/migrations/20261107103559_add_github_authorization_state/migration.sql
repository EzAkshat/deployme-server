-- CreateTable
CREATE TABLE "GitHubAuthorizationState" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitHubAuthorizationState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GitHubAuthorizationState_stateHash_key" ON "GitHubAuthorizationState"("stateHash");

-- CreateIndex
CREATE INDEX "GitHubAuthorizationState_sessionId_idx" ON "GitHubAuthorizationState"("sessionId");

-- CreateIndex
CREATE INDEX "GitHubAuthorizationState_expiresAt_idx" ON "GitHubAuthorizationState"("expiresAt");

-- AddForeignKey
ALTER TABLE "GitHubAuthorizationState" ADD CONSTRAINT "GitHubAuthorizationState_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
