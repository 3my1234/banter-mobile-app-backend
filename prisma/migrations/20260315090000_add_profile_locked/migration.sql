-- Add profile lock flag to users
ALTER TABLE "User" ADD COLUMN "profileLocked" BOOLEAN NOT NULL DEFAULT false;
