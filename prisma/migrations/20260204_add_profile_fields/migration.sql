-- Add profile fields to User
ALTER TABLE "User" ADD COLUMN "bannerUrl" TEXT;
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
ALTER TABLE "User" ADD COLUMN "country" TEXT;
ALTER TABLE "User" ADD COLUMN "dateOfBirth" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "clubs" TEXT[] DEFAULT ARRAY[]::TEXT[];
