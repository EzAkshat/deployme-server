BEGIN;

ALTER TABLE "Project"
  ADD COLUMN "ownerUserId" INTEGER,
  ALTER COLUMN "teamId" DROP NOT NULL;

CREATE INDEX "Project_ownerUserId_archivedAt_idx"
  ON "Project" ("ownerUserId", "archivedAt");

CREATE UNIQUE INDEX "Project_ownerUserId_slug_key"
  ON "Project" ("ownerUserId", "slug");

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_exactly_one_owner"
  CHECK (("teamId" IS NOT NULL) <> ("ownerUserId" IS NOT NULL));

COMMIT;