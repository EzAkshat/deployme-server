
-- Create the platform role enum.
CREATE TYPE "PlatformRole" AS ENUM (
  'SUPER_ADMIN',
  'SITE_ADMIN',
  'USER'
);

-- Replace the team role enum while preserving existing memberships.
BEGIN;

CREATE TYPE "TeamRole_new" AS ENUM (
  'OWNER',
  'MANAGER',
  'MEMBER'
);

ALTER TABLE "public"."TeamMembership"
  ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "public"."TeamMembership"
  ALTER COLUMN "role" TYPE "TeamRole_new"
  USING (
    CASE "role"::text
      WHEN 'ADMIN' THEN 'MANAGER'
      WHEN 'VIEWER' THEN 'MEMBER'
      ELSE "role"::text
    END
  )::"TeamRole_new";

ALTER TYPE "TeamRole" RENAME TO "TeamRole_old";

ALTER TYPE "TeamRole_new" RENAME TO "TeamRole";

DROP TYPE "public"."TeamRole_old";

ALTER TABLE "public"."TeamMembership"
  ALTER COLUMN "role" SET DEFAULT 'MEMBER';

COMMIT;

-- Add the platform role to existing users.
-- Existing users receive USER by default.
ALTER TABLE "public"."User"
  ADD COLUMN "platformRole" "PlatformRole" NOT NULL DEFAULT 'USER';
