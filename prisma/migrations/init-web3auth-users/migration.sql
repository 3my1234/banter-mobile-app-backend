-- AlterTable: Remove Privy-specific fields and add Web3Auth fields
ALTER TABLE "User" DROP COLUMN IF EXISTS "privyDid";
ALTER TABLE "User" DROP COLUMN IF EXISTS "privyUserId";
ALTER TABLE "User" DROP COLUMN IF EXISTS "name";

-- Add new Web3Auth fields
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "displayName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "solanaAddress" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "movementAddress" TEXT;

-- Create unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX IF NOT EXISTS "User_solanaAddress_key" ON "User"("solanaAddress");
CREATE UNIQUE INDEX IF NOT EXISTS "User_movementAddress_key" ON "User"("movementAddress");

-- Create indexes
CREATE INDEX IF NOT EXISTS "User_username_idx" ON "User"("username");

-- Drop old indexes if they exist
DROP INDEX IF EXISTS "User_privyDid_idx";
