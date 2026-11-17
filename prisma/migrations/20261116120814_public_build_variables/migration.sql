-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "publicBuildVariables" JSONB NOT NULL DEFAULT '{}';
