-- CreateEnum
CREATE TYPE "AdPlacement" AS ENUM ('POST_FEED', 'BANTER_FEED');

-- CreateTable
CREATE TABLE "AdSettings" (
    "id" TEXT NOT NULL,
    "postFrequency" INTEGER NOT NULL DEFAULT 6,
    "banterFrequency" INTEGER NOT NULL DEFAULT 8,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdCampaign" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "targetUrl" TEXT,
    "ctaLabel" TEXT,
    "placement" "AdPlacement" NOT NULL DEFAULT 'POST_FEED',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdCampaign_placement_isActive_idx" ON "AdCampaign"("placement", "isActive");

-- CreateIndex
CREATE INDEX "AdCampaign_startsAt_endsAt_idx" ON "AdCampaign"("startsAt", "endsAt");
