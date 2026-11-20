/*
  Warnings:

  - Added the required column `updatedAt` to the `Application` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ApiKeyMode" AS ENUM ('FREE', 'PRO');

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "applied" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "coverPdfUrl" TEXT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "keyPreview" TEXT,
ADD COLUMN     "mode" TEXT,
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "resultInfo" JSONB,
ADD COLUMN     "resumePdfUrl" TEXT,
ADD COLUMN     "resumeTemplate" TEXT,
ADD COLUMN     "submitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'APPLIED';

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "autoFillPrefs" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "autoFillPromptId" TEXT,
ADD COLUMN     "bulletMax" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "bulletMin" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "certifications" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "education" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "promptId" TEXT,
ADD COLUMN     "resumeTemplateId" TEXT NOT NULL DEFAULT 'style2';

-- CreateTable
CREATE TABLE "ProfileApiKey" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "mode" "ApiKeyMode" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfileApiKey_profileId_mode_idx" ON "ProfileApiKey"("profileId", "mode");

-- CreateIndex
CREATE INDEX "Application_ownerId_idx" ON "Application"("ownerId");

-- CreateIndex
CREATE INDEX "Application_createdAt_idx" ON "Application"("createdAt");

-- AddForeignKey
ALTER TABLE "ProfileApiKey" ADD CONSTRAINT "ProfileApiKey_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
