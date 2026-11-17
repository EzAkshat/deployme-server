-- AlterEnum
ALTER TYPE "TeamInvitationStatus" ADD VALUE 'DECLINED';

-- AlterTable
ALTER TABLE "TeamInvitation" ADD COLUMN     "declinedAt" TIMESTAMP(3);
