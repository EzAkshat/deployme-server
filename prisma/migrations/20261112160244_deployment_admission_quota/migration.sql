-- CreateTable
CREATE TABLE "DeploymentQuotaLock" (
    "scopeKey" VARCHAR(160) NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "DeploymentQuotaLock_pkey" PRIMARY KEY ("scopeKey")
);
