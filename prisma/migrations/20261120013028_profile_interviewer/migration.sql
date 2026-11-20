-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "interviewerId" TEXT;

-- CreateIndex
CREATE INDEX "Profile_interviewerId_idx" ON "Profile"("interviewerId");

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_interviewerId_fkey" FOREIGN KEY ("interviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
