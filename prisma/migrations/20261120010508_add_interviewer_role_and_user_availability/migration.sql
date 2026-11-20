-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'INTERVIEWER';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'America/New_York';

-- CreateTable
CREATE TABLE "UserAvailabilityRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "UserAvailabilityRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserAvailabilityOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "type" "OverrideType" NOT NULL,

    CONSTRAINT "UserAvailabilityOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAvailabilityRule_userId_idx" ON "UserAvailabilityRule"("userId");

-- CreateIndex
CREATE INDEX "UserAvailabilityOverride_userId_date_idx" ON "UserAvailabilityOverride"("userId", "date");

-- AddForeignKey
ALTER TABLE "UserAvailabilityRule" ADD CONSTRAINT "UserAvailabilityRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAvailabilityOverride" ADD CONSTRAINT "UserAvailabilityOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
