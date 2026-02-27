-- Add daily ROL reward tracking to users
ALTER TABLE "User"
ADD COLUMN "rolBalanceRaw" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "lastDailyRolAt" TIMESTAMP(3);

-- Notification system
CREATE TYPE "NotificationType" AS ENUM (
  'SYSTEM',
  'VOTE_PURCHASE',
  'WALLET_RECEIVE',
  'WALLET_TRANSFER',
  'COMMENT_REPLY',
  'DAILY_ROL',
  'XP'
);

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "NotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "data" JSONB,
  "reference" TEXT,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Notification_reference_key" ON "Notification"("reference");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX "Notification_type_idx" ON "Notification"("type");

ALTER TABLE "Notification"
ADD CONSTRAINT "Notification_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
