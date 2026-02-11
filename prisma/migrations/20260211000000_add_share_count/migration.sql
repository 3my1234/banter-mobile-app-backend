-- Add shareCount to Post
ALTER TABLE "Post" ADD COLUMN "shareCount" INTEGER NOT NULL DEFAULT 0;
