/*
  Warnings:

  - A unique constraint covering the columns `[subdomain]` on the table `Project` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "subdomain" VARCHAR(63);

-- CreateIndex
CREATE UNIQUE INDEX "Project_subdomain_key" ON "Project"("subdomain");
