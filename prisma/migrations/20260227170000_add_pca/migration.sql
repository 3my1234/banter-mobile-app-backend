CREATE TYPE "PcaSport" AS ENUM ('SOCCER', 'BASKETBALL');

CREATE TYPE "PcaCategoryType" AS ENUM (
  'GOAL_OF_WEEK',
  'PLAYER_OF_MONTH',
  'TOURNAMENT_AWARD',
  'BALLON_DOR_PEOPLES_CHOICE',
  'CUSTOM'
);

CREATE TABLE "PcaCategory" (
  "id" TEXT NOT NULL,
  "sport" "PcaSport" NOT NULL,
  "season" TEXT NOT NULL,
  "categoryType" "PcaCategoryType" NOT NULL DEFAULT 'CUSTOM',
  "title" TEXT NOT NULL,
  "subtitle" TEXT,
  "roundLabel" TEXT,
  "description" TEXT,
  "criteria" JSONB,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PcaCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PcaNominee" (
  "id" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "team" TEXT,
  "country" TEXT,
  "position" TEXT,
  "imageUrl" TEXT,
  "videoUrl" TEXT,
  "stats" JSONB,
  "voteCount" INTEGER NOT NULL DEFAULT 0,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PcaNominee_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PcaVote" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "nomineeId" TEXT NOT NULL,
  "votes" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PcaVote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PcaCategory_sport_season_isActive_idx" ON "PcaCategory"("sport", "season", "isActive");
CREATE INDEX "PcaCategory_categoryType_idx" ON "PcaCategory"("categoryType");
CREATE INDEX "PcaNominee_categoryId_voteCount_idx" ON "PcaNominee"("categoryId", "voteCount");
CREATE INDEX "PcaNominee_sortOrder_idx" ON "PcaNominee"("sortOrder");
CREATE INDEX "PcaVote_userId_createdAt_idx" ON "PcaVote"("userId", "createdAt");
CREATE INDEX "PcaVote_categoryId_idx" ON "PcaVote"("categoryId");
CREATE INDEX "PcaVote_nomineeId_idx" ON "PcaVote"("nomineeId");

ALTER TABLE "PcaNominee"
ADD CONSTRAINT "PcaNominee_categoryId_fkey"
FOREIGN KEY ("categoryId") REFERENCES "PcaCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PcaVote"
ADD CONSTRAINT "PcaVote_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PcaVote"
ADD CONSTRAINT "PcaVote_categoryId_fkey"
FOREIGN KEY ("categoryId") REFERENCES "PcaCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PcaVote"
ADD CONSTRAINT "PcaVote_nomineeId_fkey"
FOREIGN KEY ("nomineeId") REFERENCES "PcaNominee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
