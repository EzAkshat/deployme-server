-- CreateTable
CREATE TABLE "GitHubConnection" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "githubUserId" BIGINT NOT NULL,
    "githubLogin" VARCHAR(255) NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GitHubConnection_userId_key" ON "GitHubConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubConnection_githubUserId_key" ON "GitHubConnection"("githubUserId");

-- AddForeignKey
ALTER TABLE "GitHubConnection" ADD CONSTRAINT "GitHubConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
