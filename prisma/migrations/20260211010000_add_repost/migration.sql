-- Add repost fields to Post
ALTER TABLE "Post" ADD COLUMN "repostOfId" TEXT;
ALTER TABLE "Post" ADD COLUMN "repostCount" INTEGER NOT NULL DEFAULT 0;

-- Self-relation for reposts
ALTER TABLE "Post"
  ADD CONSTRAINT "Post_repostOfId_fkey"
  FOREIGN KEY ("repostOfId") REFERENCES "Post"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Post_repostOfId_idx" ON "Post"("repostOfId");
CREATE UNIQUE INDEX "Post_userId_repostOfId_key" ON "Post"("userId", "repostOfId");
