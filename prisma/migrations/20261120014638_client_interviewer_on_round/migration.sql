-- AlterTable
ALTER TABLE "Round" ADD COLUMN     "clientInterviewerAbout" TEXT,
ADD COLUMN     "clientInterviewerName" TEXT NOT NULL DEFAULT '';
