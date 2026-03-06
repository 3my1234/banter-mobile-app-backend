ALTER TABLE "User"
ADD COLUMN "banterPointsRaw" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "lastDailyPointsAt" TIMESTAMP(3);

DO $$
BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DAILY_POINTS';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TYPE "PointLedgerType" AS ENUM (
  'LOGIN',
  'EARLY_USER',
  'FIRST_ROLLEY_STAKE',
  'POST',
  'PCA',
  'REFERRAL',
  'ADMIN_ADJUSTMENT'
);

CREATE TABLE "PointLedger" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "PointLedgerType" NOT NULL,
  "pointsRaw" BIGINT NOT NULL,
  "reference" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PointLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PointLedger_reference_key" ON "PointLedger"("reference");
CREATE INDEX "PointLedger_userId_createdAt_idx" ON "PointLedger"("userId", "createdAt");
CREATE INDEX "PointLedger_type_idx" ON "PointLedger"("type");

ALTER TABLE "PointLedger"
ADD CONSTRAINT "PointLedger_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
