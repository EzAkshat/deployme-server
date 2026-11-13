-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "buildCommand" VARCHAR(500) NOT NULL DEFAULT 'npm run build',
ADD COLUMN     "installCommand" VARCHAR(500) NOT NULL DEFAULT 'npm install',
ADD COLUMN     "outputDirectory" VARCHAR(255) NOT NULL DEFAULT 'dist',
ADD COLUMN     "rootDirectory" VARCHAR(255) NOT NULL DEFAULT '.';
